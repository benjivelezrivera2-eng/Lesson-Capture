using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

// A local-only replacement for the temporary Python receiver. The extension
// sends media bytes only to 127.0.0.1; it never forwards course media, cookies,
// signed URLs, or account data to another machine.
public static class LessonCaptureCollector
{
    private const long MaxSegmentBytes = 100L * 1024L * 1024L;
    // Parallel segment fetches cut wait time on long HLS lessons. Quality is
    // aimed at ~720p so agents can read the lesson without multi-hour 1080p/4K pulls.
    private const int MaxParallelSegments = 12;
    private const int TargetHeight = 720;
    private const int TargetBandwidth = 2500000;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly ConcurrentDictionary<string, CaptureSession> Sessions = new ConcurrentDictionary<string, CaptureSession>();
    private static readonly ConcurrentDictionary<string, DownloadSession> Downloads = new ConcurrentDictionary<string, DownloadSession>();
    private static readonly int Port = ResolvePort();
    private static readonly string CaptureRoot = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "BenjiLessonCapture", "cache");
    // Keep finished videos in a normal local folder the user can reach. Raw
    // fragments stay in the private cache and are not the deliverable.
    private static readonly string FinishedVideoRoot = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.MyVideos),
        "Lesson Captures");
    // Jellyfin installs a local ffmpeg binary on this computer. The collector
    // uses it only to mux already-local audio/video fragments into an MP4.
    private static readonly string FfmpegPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
        "Jellyfin", "Server", "ffmpeg.exe");
    private static readonly string FfprobePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
        "Jellyfin", "Server", "ffprobe.exe");

    private sealed class CaptureSession
    {
        public string Id;
        public string Folder;
        public string Title;
        public string LessonUrl;
        public DateTime StartedAt;
        public int AudioCount;
        public int VideoCount;
        public int ManifestCount;
    }

    private sealed class DownloadSession
    {
        public string Id;
        public string Title;
        public string LessonUrl;
        public string JobKey;
        public string OutputFile;
        public string Status;
        public string Error;
        public string Phase;
        public int SegmentsDone;
        public int SegmentsTotal;
        public long BytesDownloaded;
        public int CancelRequested;
    }

    public static void Main(string[] args)
    {
        if (args.Length == 2 && string.Equals(args[0], "--package", StringComparison.OrdinalIgnoreCase))
        {
            PackageExisting(args[1]);
            return;
        }
        // HttpWebRequest allows only 2 connections per host by default. Raise
        // that so MaxParallelSegments workers can actually fetch at once (room
        // for a few concurrent lesson downloads hitting the same CDN).
        ServicePointManager.DefaultConnectionLimit = MaxParallelSegments * 3;
        Directory.CreateDirectory(CaptureRoot);
        Directory.CreateDirectory(FinishedVideoRoot);
        using (var listener = new HttpListener())
        {
            listener.Prefixes.Add("http://127.0.0.1:" + Port + "/");
            listener.Start();
            while (true)
            {
                var context = listener.GetContext();
                ThreadPool.QueueUserWorkItem(_ => Handle(context));
            }
        }
    }

    private static void Handle(HttpListenerContext context)
    {
        try
        {
            var path = context.Request.Url.AbsolutePath.TrimEnd('/');
            if (context.Request.HttpMethod == "GET" && path == "/health")
            {
            Respond(context, HttpStatusCode.OK, new { ok = true, service = "LessonCaptureCollector", port = Port, outputRoot = FinishedVideoRoot });
                return;
            }
            if (context.Request.HttpMethod == "POST" && path == "/session")
            {
                StartSession(context);
                return;
            }
            if (context.Request.HttpMethod == "POST" && path == "/download")
            {
                StartDownload(context);
                return;
            }
            if (context.Request.HttpMethod == "POST" && path == "/download/cancel-all")
            {
                CancelAllDownloads(context);
                return;
            }
            if (context.Request.HttpMethod == "POST" && path.StartsWith("/download/") && path.EndsWith("/cancel"))
            {
                var rest = path.Substring("/download/".Length);
                CancelDownload(context, rest.Substring(0, rest.Length - "/cancel".Length));
                return;
            }
            if (context.Request.HttpMethod == "GET" && path.StartsWith("/download/"))
            {
                GetDownload(context, path.Substring("/download/".Length));
                return;
            }
            if (context.Request.HttpMethod == "POST" && path == "/reveal")
            {
                RevealDownload(context);
                return;
            }
            if (context.Request.HttpMethod == "POST" && path == "/segment")
            {
                SaveSegment(context);
                return;
            }
            if (context.Request.HttpMethod == "POST" && path.StartsWith("/session/") && path.EndsWith("/complete"))
            {
                CompleteSession(context, path.Split('/')[2]);
                return;
            }
            Respond(context, HttpStatusCode.NotFound, new { error = "not found" });
        }
        catch (Exception error)
        {
            Respond(context, HttpStatusCode.InternalServerError, new { error = error.Message });
        }
    }

    private static void StartSession(HttpListenerContext context)
    {
        var payload = ReadJson(context.Request);
        var id = Guid.NewGuid().ToString("N");
        var title = Text(payload, "title", "lesson");
        var stamp = DateTime.UtcNow.ToString("yyyy-MM-dd_HH-mm-ss");
        var folder = Path.Combine(CaptureRoot, stamp + " - " + SafeName(title) + " - " + id.Substring(0, 8));
        foreach (var track in new[] { "audio", "video", "manifests" }) Directory.CreateDirectory(Path.Combine(folder, track));

        var session = new CaptureSession {
            Id = id, Folder = folder, Title = title, LessonUrl = Text(payload, "lessonUrl", ""), StartedAt = DateTime.UtcNow
        };
        Sessions[id] = session;
        WriteMetadata(session, null);
        Respond(context, HttpStatusCode.Created, new { id = id, folder = folder });
    }

    private static void StartDownload(HttpListenerContext context)
    {
        var payload = ReadJson(context.Request);
        var mediaUrl = Text(payload, "mediaUrl", Text(payload, "manifestUrl", ""));
        Uri media;
        if (!IsPublicMediaUrl(mediaUrl, out media))
        {
            Respond(context, HttpStatusCode.BadRequest, new { error = "An accessible public HTTPS MP4 or HLS URL is required." });
            return;
        }
        var referer = Text(payload, "referer", "https://app.jointherealworld.com/");
        Uri page;
        if (!Uri.TryCreate(referer, UriKind.Absolute, out page) || page.Scheme != "https" || !IsPublicHost(page.Host))
        {
            Respond(context, HttpStatusCode.BadRequest, new { error = "A public HTTPS page origin is required." });
            return;
        }
        Directory.CreateDirectory(FinishedVideoRoot);
        var id = Guid.NewGuid().ToString("N");
        var title = Text(payload, "title", "lesson");
        var lessonUrl = Text(payload, "lessonUrl", "");
        // One course page can contain several independent videos. The browser
        // supplies a stable per-video key so the duplicate guard rejects only
        // the same video, not the other videos in that lesson.
        var jobKey = Text(payload, "jobKey", lessonUrl);
        if (string.IsNullOrWhiteSpace(jobKey)) jobKey = lessonUrl;
        foreach (var existing in Downloads.Values)
        {
            if (string.Equals(existing.JobKey, jobKey, StringComparison.Ordinal))
            {
                // The extension may be restarted while a page is authorizing.
                // The collector is the final guard against duplicate MP4 jobs.
                Respond(context, HttpStatusCode.OK, new { id = existing.Id, status = existing.Status, outputFile = existing.OutputFile, alreadyKnown = true });
                return;
            }
        }
        var output = Path.Combine(FinishedVideoRoot, OutputName(new CaptureSession { Id = id, Title = title, StartedAt = DateTime.UtcNow }));
        var download = new DownloadSession {
            Id = id, Title = title, LessonUrl = lessonUrl, JobKey = jobKey,
            OutputFile = output, Status = "downloading", Phase = "starting"
        };
        Downloads[id] = download;
        ThreadPool.QueueUserWorkItem(_ => DownloadManifest(download, mediaUrl, page.GetLeftPart(UriPartial.Authority) + "/"));
        // The signed manifest URL is intentionally never written to disk.
        Respond(context, HttpStatusCode.Accepted, new { id = id, status = download.Status, outputFile = output });
    }

    private static void GetDownload(HttpListenerContext context, string id)
    {
        DownloadSession download;
        if (!Downloads.TryGetValue(id, out download))
        {
            Respond(context, HttpStatusCode.NotFound, new { error = "unknown download" });
            return;
        }
        Respond(context, HttpStatusCode.OK, new {
            id = download.Id,
            title = download.Title,
            status = download.Status,
            outputFile = download.OutputFile,
            error = download.Error,
            phase = download.Phase,
            segmentsDone = download.SegmentsDone,
            segmentsTotal = download.SegmentsTotal,
            bytesDownloaded = download.BytesDownloaded,
            percent = ProgressPercent(download)
        });
    }

    private static void CancelDownload(HttpListenerContext context, string id)
    {
        DownloadSession download;
        if (!Downloads.TryGetValue(id, out download))
        {
            Respond(context, HttpStatusCode.NotFound, new { error = "unknown download" });
            return;
        }
        RequestCancel(download);
        Respond(context, HttpStatusCode.OK, new { id = download.Id, status = "cancelling" });
    }

    private static void CancelAllDownloads(HttpListenerContext context)
    {
        var count = 0;
        foreach (var download in Downloads.Values)
        {
            if (download.Status != "downloading") continue;
            RequestCancel(download);
            count += 1;
        }
        Respond(context, HttpStatusCode.OK, new { cancelled = count });
    }

    private static void RequestCancel(DownloadSession download)
    {
        Interlocked.Exchange(ref download.CancelRequested, 1);
        if (string.Equals(download.Status, "downloading", StringComparison.Ordinal))
        {
            download.Phase = "cancelling";
        }
    }

    private static bool IsCancelled(DownloadSession download)
    {
        return Interlocked.CompareExchange(ref download.CancelRequested, 0, 0) != 0;
    }

    private static void ThrowIfCancelled(DownloadSession download)
    {
        if (IsCancelled(download)) throw new OperationCanceledException("Stopped by user.");
    }

    private static int? ProgressPercent(DownloadSession download)
    {
        if (download.SegmentsTotal > 0)
            return Math.Min(99, (int)((download.SegmentsDone * 100L) / download.SegmentsTotal));
        return null;
    }

    private static void RevealDownload(HttpListenerContext context)
    {
        var payload = ReadJson(context.Request);
        var id = Text(payload, "id", "");
        DownloadSession download;
        string target = null;
        if (!string.IsNullOrEmpty(id) && Downloads.TryGetValue(id, out download))
            target = download.OutputFile;
        if (string.IsNullOrEmpty(target)) target = Text(payload, "outputFile", "");
        if (string.IsNullOrEmpty(target) || !File.Exists(target))
        {
            Respond(context, HttpStatusCode.NotFound, new { error = "finished file not found" });
            return;
        }
        var full = Path.GetFullPath(target);
        var root = Path.GetFullPath(FinishedVideoRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase))
        {
            Respond(context, HttpStatusCode.Forbidden, new { error = "file is outside Lesson Captures" });
            return;
        }
        Process.Start(new ProcessStartInfo {
            FileName = "explorer.exe",
            Arguments = "/select," + Quote(full),
            UseShellExecute = true
        });
        Respond(context, HttpStatusCode.OK, new { ok = true, outputFile = full });
    }

    private static void DownloadManifest(DownloadSession download, string mediaUrl, string referer)
    {
        // Segment work stays in the private cache. A visible .partial.mp4 appears
        // in Lesson Captures immediately so Explorer shows the capture starting.
        var workDir = Path.Combine(CaptureRoot, "downloads", download.Id);
        var stagingOutput = download.OutputFile + ".partial.mp4";
        try
        {
            Directory.CreateDirectory(workDir);
            Directory.CreateDirectory(FinishedVideoRoot);
            using (File.Create(stagingOutput)) { }
            download.Phase = "downloading";
            ThrowIfCancelled(download);
            if (mediaUrl.IndexOf(".m3u8", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                try
                {
                    DownloadHlsParallel(download, mediaUrl, referer, stagingOutput, workDir);
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception parallelError)
                {
                    ThrowIfCancelled(download);
                    DeleteIfExists(stagingOutput);
                    using (File.Create(stagingOutput)) { }
                    download.Phase = "downloading";
                    download.SegmentsDone = 0;
                    download.SegmentsTotal = 0;
                    // Unusual playlist layouts still fall back to ffmpeg's
                    // sequential reader so a capture still completes.
                    RunFfmpegManifest(mediaUrl, referer, stagingOutput);
                    if (!File.Exists(stagingOutput) || new FileInfo(stagingOutput).Length == 0)
                        throw new InvalidOperationException(
                            "Parallel HLS failed (" + parallelError.Message + ") and ffmpeg produced no MP4");
                }
            }
            else
            {
                RunFfmpegManifest(mediaUrl, referer, stagingOutput);
            }
            ThrowIfCancelled(download);
            download.Phase = "verifying";
            if (!File.Exists(stagingOutput) || new FileInfo(stagingOutput).Length == 0)
                throw new InvalidOperationException("ffmpeg did not produce an MP4");
            VerifyMp4(stagingOutput);
            ThrowIfCancelled(download);
            if (File.Exists(download.OutputFile)) throw new IOException("A finished MP4 already exists at " + download.OutputFile);
            File.Move(stagingOutput, download.OutputFile);
            download.Phase = "complete";
            download.Status = "complete";
            if (download.SegmentsTotal > 0) download.SegmentsDone = download.SegmentsTotal;
        }
        catch (OperationCanceledException)
        {
            download.Status = "cancelled";
            download.Phase = "cancelled";
            download.Error = "Stopped by user.";
        }
        catch (Exception error)
        {
            if (IsCancelled(download))
            {
                download.Status = "cancelled";
                download.Phase = "cancelled";
                download.Error = "Stopped by user.";
            }
            else
            {
                download.Status = "failed";
                download.Phase = "failed";
                download.Error = SafeDownloadError(error.Message);
            }
        }
        finally
        {
            DeleteIfExists(stagingOutput);
            try { if (Directory.Exists(workDir)) Directory.Delete(workDir, true); } catch { /* best-effort cleanup */ }
        }
    }

    private static void SaveSegment(HttpListenerContext context)
    {
        var id = context.Request.Headers["X-Capture-Session"] ?? "";
        CaptureSession session;
        if (!Sessions.TryGetValue(id, out session))
        {
            Respond(context, HttpStatusCode.BadRequest, new { error = "unknown session" });
            return;
        }
        var track = context.Request.Headers["X-Capture-Track"] ?? "";
        if (track != "audio" && track != "video" && track != "manifests")
        {
            Respond(context, HttpStatusCode.BadRequest, new { error = "invalid track" });
            return;
        }
        if (context.Request.ContentLength64 < 0 || context.Request.ContentLength64 > MaxSegmentBytes)
        {
            Respond(context, HttpStatusCode.RequestEntityTooLarge, new { error = "segment is too large" });
            return;
        }
        var name = SafeName(context.Request.Headers["X-Capture-Name"] ?? "segment.bin");
        var destination = Path.Combine(session.Folder, track, name);
        var temporary = destination + ".partial";
        using (var output = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            context.Request.InputStream.CopyTo(output);
        }
        if (File.Exists(destination)) File.Delete(destination);
        File.Move(temporary, destination);
        if (track == "audio") Interlocked.Increment(ref session.AudioCount);
        else if (track == "video") Interlocked.Increment(ref session.VideoCount);
        else Interlocked.Increment(ref session.ManifestCount);
        Respond(context, HttpStatusCode.NoContent, null);
    }

    private static void CompleteSession(HttpListenerContext context, string id)
    {
        CaptureSession session;
        if (!Sessions.TryRemove(id, out session))
        {
            Respond(context, HttpStatusCode.NotFound, new { error = "unknown session" });
            return;
        }
        var completedAt = DateTime.UtcNow;
        WriteMetadata(session, completedAt, "packaging", null);
        ThreadPool.QueueUserWorkItem(_ => PackageSession(session, completedAt));
        Respond(context, HttpStatusCode.OK, new { folder = session.Folder, status = "packaging" });
    }

    private static Dictionary<string, object> ReadJson(HttpListenerRequest request)
    {
        using (var reader = new StreamReader(request.InputStream, Encoding.UTF8))
        {
            return Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd()) ?? new Dictionary<string, object>();
        }
    }

    private static void PackageExisting(string folder)
    {
        var fullFolder = Path.GetFullPath(folder);
        if (!Directory.Exists(fullFolder)) throw new DirectoryNotFoundException(fullFolder);
        PackageSession(new CaptureSession {
            Id = "recovered", Folder = fullFolder, Title = Path.GetFileName(fullFolder), StartedAt = DateTime.UtcNow
        }, DateTime.UtcNow);
    }

    private static void PackageSession(CaptureSession session, DateTime completedAt)
    {
        try
        {
            if (!File.Exists(FfmpegPath)) throw new FileNotFoundException("ffmpeg was not found", FfmpegPath);
            var audioFolder = Path.Combine(session.Folder, "audio");
            var videoFolder = Path.Combine(session.Folder, "video");
            var audioTrack = Path.Combine(session.Folder, "audio-track.partial.mp4");
            var videoTrack = Path.Combine(session.Folder, "video-track.partial.mp4");
            var stagingOutput = Path.Combine(session.Folder, "lesson.partial.mp4");
            Directory.CreateDirectory(FinishedVideoRoot);
            var output = Path.Combine(FinishedVideoRoot, OutputName(session));
            try
            {
                JoinTrack(audioFolder, audioTrack);
                JoinTrack(videoFolder, videoTrack);
                RunFfmpeg(videoTrack, audioTrack, stagingOutput);
                if (!File.Exists(stagingOutput) || new FileInfo(stagingOutput).Length == 0)
                    throw new InvalidOperationException("ffmpeg did not produce an MP4");
                if (File.Exists(output)) throw new IOException("A finished MP4 already exists at " + output);
                File.Move(stagingOutput, output);
            }
            finally
            {
                DeleteIfExists(audioTrack);
                DeleteIfExists(videoTrack);
                DeleteIfExists(stagingOutput);
            }
            // Raw pieces remain as a recovery cache. They are never mixed into
            // the final MP4 and can be cleaned only after the user has reviewed it.
            WriteMetadata(session, completedAt, "complete", output);
        }
        catch (Exception error)
        {
            // Keep the raw pieces whenever packaging fails so this is recoverable.
            WriteMetadata(session, completedAt, "failed", null, error.Message);
        }
    }

    private static void JoinTrack(string sourceFolder, string destination)
    {
        if (!Directory.Exists(sourceFolder)) throw new DirectoryNotFoundException(sourceFolder);
        var files = new List<string>(Directory.GetFiles(sourceFolder, "*.mp4"));
        files.Sort(StringComparer.Ordinal);
        var ordered = new List<string>();
        ordered.AddRange(files.FindAll(path => path.EndsWith("-init.mp4", StringComparison.OrdinalIgnoreCase)));
        ordered.AddRange(files.FindAll(path => !path.EndsWith("-init.mp4", StringComparison.OrdinalIgnoreCase)));
        if (ordered.Count == 0) throw new InvalidOperationException("No " + Path.GetFileName(sourceFolder) + " fragments were saved");
        using (var output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            foreach (var path in ordered)
            {
                using (var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    input.CopyTo(output);
                }
            }
        }
    }

    private static void RunFfmpeg(string videoTrack, string audioTrack, string output)
    {
        var start = new ProcessStartInfo {
            FileName = FfmpegPath,
            Arguments = "-y -v error -i " + Quote(videoTrack) + " -i " + Quote(audioTrack) +
                " -map 0:v:0 -map 1:a:0 -c copy -movflags +faststart " + Quote(output),
            UseShellExecute = false,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        using (var process = Process.Start(start))
        {
            var errors = process.StandardError.ReadToEnd();
            process.WaitForExit();
            if (process.ExitCode != 0) throw new InvalidOperationException("ffmpeg failed: " + errors.Trim());
        }
    }

    private static bool IsPublicMediaUrl(string value, out Uri media)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out media) || media.Scheme != "https" ||
            !string.IsNullOrEmpty(media.UserInfo) || media.Port != 443 || value.Length > 16384 ||
            !IsPublicHost(media.Host)) return false;
        var path = media.AbsolutePath;
        return path.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase) ||
            path.EndsWith(".m3u8", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsPublicHost(string host)
    {
        if (string.IsNullOrWhiteSpace(host) || host.Equals("localhost", StringComparison.OrdinalIgnoreCase) ||
            !host.Contains(".")) return false;
        try
        {
            var found = false;
            foreach (var address in Dns.GetHostAddresses(host))
            {
                found = true;
                if (IPAddress.IsLoopback(address)) return false;
                var bytes = address.GetAddressBytes();
                if (bytes.Length == 4 && (bytes[0] == 0 || bytes[0] == 10 || bytes[0] == 127 ||
                    bytes[0] >= 224 || (bytes[0] == 169 && bytes[1] == 254) ||
                    (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31) ||
                    (bytes[0] == 192 && bytes[1] == 168) ||
                    (bytes[0] == 100 && bytes[1] >= 64 && bytes[1] <= 127))) return false;
                if (bytes.Length == 16 && (bytes[0] & 0xe0) != 0x20) return false;
            }
            return found;
        }
        catch { return false; }
    }

    private static string SafeDownloadError(string error)
    {
        if (error.IndexOf("401", StringComparison.OrdinalIgnoreCase) >= 0 ||
            error.IndexOf("403", StringComparison.OrdinalIgnoreCase) >= 0)
            return "The media URL was denied or expired (HTTP 401/403). Retry from the open video page.";
        if (error.IndexOf("404", StringComparison.OrdinalIgnoreCase) >= 0)
            return "The media URL was not found (HTTP 404).";
        if (error == "ffprobe was not found" || error == "ffmpeg was not found") return error;
        return "The stream could not be converted to a playable MP4. It may be unavailable, protected, or unsupported.";
    }

    private static void VerifyMp4(string output)
    {
        if (!File.Exists(FfprobePath)) throw new InvalidOperationException("ffprobe was not found");
        var start = new ProcessStartInfo {
            FileName = FfprobePath,
            Arguments = "-v error -show_entries stream=codec_type -of csv=p=0 " + Quote(output),
            UseShellExecute = false, RedirectStandardOutput = true,
            RedirectStandardError = true, CreateNoWindow = true
        };
        using (var process = Process.Start(start))
        {
            var streams = process.StandardOutput.ReadToEnd();
            process.StandardError.ReadToEnd();
            process.WaitForExit();
            if (process.ExitCode != 0 || !streams.Contains("video"))
                throw new InvalidOperationException("The output has no playable video stream");
        }
    }

    private sealed class HlsPlaylist
    {
        public string MapUrl;
        public List<string> SegmentUrls = new List<string>();
    }

    private static void DownloadHlsParallel(DownloadSession download, string mediaUrl, string referer, string output, string workDir)
    {
        if (!File.Exists(FfmpegPath)) throw new FileNotFoundException("ffmpeg was not found", FfmpegPath);
        download.Phase = "playlist";
        string videoPlaylistUrl;
        string audioPlaylistUrl;
        SelectHlsPlaylists(mediaUrl, referer, out videoPlaylistUrl, out audioPlaylistUrl);
        var video = ParseMediaPlaylist(FetchText(videoPlaylistUrl, referer), videoPlaylistUrl);
        if (video.SegmentUrls.Count == 0) throw new InvalidOperationException("HLS playlist has no segments");
        HlsPlaylist audio = null;
        if (!string.IsNullOrEmpty(audioPlaylistUrl))
        {
            audio = ParseMediaPlaylist(FetchText(audioPlaylistUrl, referer), audioPlaylistUrl);
            if (audio.SegmentUrls.Count == 0) throw new InvalidOperationException("HLS audio playlist has no segments");
        }
        var videoCount = SegmentCount(video);
        var audioCount = audio == null ? 0 : SegmentCount(audio);
        download.SegmentsTotal = videoCount + audioCount;
        download.SegmentsDone = 0;
        download.BytesDownloaded = 0;
        download.Phase = "downloading";
        var videoTrack = Path.Combine(workDir, "video-track.bin");
        DownloadAndJoinSegments(download, video, referer, Path.Combine(workDir, "video"), videoTrack);
        ThrowIfCancelled(download);
        if (audio != null)
        {
            var audioTrack = Path.Combine(workDir, "audio-track.bin");
            DownloadAndJoinSegments(download, audio, referer, Path.Combine(workDir, "audio"), audioTrack);
            ThrowIfCancelled(download);
            download.Phase = "remuxing";
            RemuxLocalTracks(videoTrack, audioTrack, output);
        }
        else
        {
            ThrowIfCancelled(download);
            download.Phase = "remuxing";
            RemuxLocalTracks(videoTrack, null, output);
        }
    }

    private static int SegmentCount(HlsPlaylist playlist)
    {
        return playlist.SegmentUrls.Count + (string.IsNullOrEmpty(playlist.MapUrl) ? 0 : 1);
    }

    private static void SelectHlsPlaylists(string mediaUrl, string referer, out string videoPlaylistUrl, out string audioPlaylistUrl)
    {
        videoPlaylistUrl = mediaUrl;
        audioPlaylistUrl = null;
        var text = FetchText(mediaUrl, referer);
        if (text.IndexOf("#EXT-X-STREAM-INF", StringComparison.OrdinalIgnoreCase) < 0) return;

        var audioGroups = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match match in Regex.Matches(text, @"#EXT-X-MEDIA:([^\r\n]+)", RegexOptions.IgnoreCase))
        {
            var attrs = match.Groups[1].Value;
            if (attrs.IndexOf("TYPE=AUDIO", StringComparison.OrdinalIgnoreCase) < 0) continue;
            var group = MatchAttr(attrs, "GROUP-ID");
            var uri = MatchAttr(attrs, "URI");
            if (!string.IsNullOrEmpty(group) && !string.IsNullOrEmpty(uri))
                audioGroups[group] = ResolveUri(mediaUrl, uri);
        }

        string bestUri = null;
        string bestAudioGroup = null;
        var bestScore = int.MaxValue;
        var lines = text.Replace("\r\n", "\n").Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i].Trim();
            if (!line.StartsWith("#EXT-X-STREAM-INF", StringComparison.OrdinalIgnoreCase)) continue;
            var bandwidth = 0;
            var height = 0;
            var bwMatch = Regex.Match(line, @"BANDWIDTH=(\d+)", RegexOptions.IgnoreCase);
            if (bwMatch.Success) int.TryParse(bwMatch.Groups[1].Value, out bandwidth);
            var resMatch = Regex.Match(line, @"RESOLUTION=(\d+)x(\d+)", RegexOptions.IgnoreCase);
            if (resMatch.Success) int.TryParse(resMatch.Groups[2].Value, out height);
            string next = null;
            for (var j = i + 1; j < lines.Length; j++)
            {
                var candidate = lines[j].Trim();
                if (candidate.Length == 0 || candidate.StartsWith("#")) continue;
                next = candidate;
                break;
            }
            if (string.IsNullOrEmpty(next)) continue;
            var score = ScoreVariant(height, bandwidth);
            if (score >= bestScore) continue;
            bestScore = score;
            bestUri = next;
            bestAudioGroup = MatchAttr(line, "AUDIO");
        }
        if (string.IsNullOrEmpty(bestUri)) throw new InvalidOperationException("Master playlist has no usable variant");
        // Prefer ~720p (readable for AI agents). Avoid the top 1080p/4K ladder rung.
        videoPlaylistUrl = ResolveUri(mediaUrl, bestUri);
        if (!string.IsNullOrEmpty(bestAudioGroup) && audioGroups.ContainsKey(bestAudioGroup))
            audioPlaylistUrl = audioGroups[bestAudioGroup];
    }

    private static int ScoreVariant(int height, int bandwidth)
    {
        // Lower score wins. Exact 720 is best; then closest below 720; then
        // closest above; bandwidth is only a tie-break / no-resolution fallback.
        if (height > 0)
        {
            if (height == TargetHeight) return 0;
            if (height < TargetHeight) return 1000 + (TargetHeight - height);
            return 100000 + (height - TargetHeight);
        }
        return 200000 + Math.Abs(bandwidth - TargetBandwidth);
    }

    private static string MatchAttr(string attrs, string name)
    {
        var match = Regex.Match(attrs, name + @"=""([^""]+)""", RegexOptions.IgnoreCase);
        if (match.Success) return match.Groups[1].Value;
        match = Regex.Match(attrs, name + @"=([^,]+)", RegexOptions.IgnoreCase);
        return match.Success ? match.Groups[1].Value.Trim() : null;
    }

    private static HlsPlaylist ParseMediaPlaylist(string text, string playlistUrl)
    {
        var playlist = new HlsPlaylist();
        var lines = text.Replace("\r\n", "\n").Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i].Trim();
            if (line.StartsWith("#EXT-X-MAP:", StringComparison.OrdinalIgnoreCase))
            {
                var uri = MatchAttr(line.Substring("#EXT-X-MAP:".Length), "URI");
                if (!string.IsNullOrEmpty(uri)) playlist.MapUrl = ResolveUri(playlistUrl, uri);
                continue;
            }
            if (line.Length == 0 || line.StartsWith("#")) continue;
            playlist.SegmentUrls.Add(ResolveUri(playlistUrl, line));
        }
        return playlist;
    }

    private static void DownloadAndJoinSegments(DownloadSession download, HlsPlaylist playlist, string referer, string segmentDir, string joinedPath)
    {
        Directory.CreateDirectory(segmentDir);
        var urls = new List<string>();
        if (!string.IsNullOrEmpty(playlist.MapUrl)) urls.Add(playlist.MapUrl);
        urls.AddRange(playlist.SegmentUrls);
        var paths = new string[urls.Count];
        Exception failure = null;
        var gate = new Semaphore(MaxParallelSegments, MaxParallelSegments);
        Parallel.For(0, urls.Count, new ParallelOptions { MaxDegreeOfParallelism = MaxParallelSegments }, index =>
        {
            gate.WaitOne();
            try
            {
                if (failure != null || IsCancelled(download)) return;
                var path = Path.Combine(segmentDir, index.ToString("D6") + ".part");
                var bytes = FetchToFile(urls[index], referer, path);
                paths[index] = path;
                Interlocked.Increment(ref download.SegmentsDone);
                Interlocked.Add(ref download.BytesDownloaded, bytes);
            }
            catch (Exception error)
            {
                Interlocked.CompareExchange(ref failure, error, null);
            }
            finally
            {
                gate.Release();
            }
        });
        ThrowIfCancelled(download);
        if (failure != null) throw failure;
        download.Phase = "joining";
        ThrowIfCancelled(download);
        using (var output = new FileStream(joinedPath, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            for (var i = 0; i < paths.Length; i++)
            {
                using (var input = new FileStream(paths[i], FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    input.CopyTo(output);
                }
            }
        }
    }

    private static void RemuxLocalTracks(string videoTrack, string audioTrack, string output)
    {
        var args = string.IsNullOrEmpty(audioTrack)
            ? "-nostdin -y -v error -i " + Quote(videoTrack) + " -c copy " + Quote(output)
            : "-nostdin -y -v error -i " + Quote(videoTrack) + " -i " + Quote(audioTrack) +
              " -map 0:v:0 -map 1:a:0 -c copy " + Quote(output);
        var start = new ProcessStartInfo {
            FileName = FfmpegPath,
            Arguments = args,
            UseShellExecute = false,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        using (var process = Process.Start(start))
        {
            var errors = process.StandardError.ReadToEnd();
            process.WaitForExit();
            if (process.ExitCode != 0) throw new InvalidOperationException(errors.Trim());
        }
    }

    private static string ResolveUri(string baseUrl, string relative)
    {
        var resolved = new Uri(new Uri(baseUrl), relative);
        // Signed playlists often put the token only on the parent URL. Relative
        // segment paths would otherwise drop it and fail with HTTP 403.
        if (string.IsNullOrEmpty(resolved.Query))
        {
            var parent = new Uri(baseUrl);
            if (!string.IsNullOrEmpty(parent.Query))
                return resolved.GetLeftPart(UriPartial.Path) + parent.Query;
        }
        return resolved.AbsoluteUri;
    }

    private static string FetchText(string url, string referer)
    {
        return Encoding.UTF8.GetString(FetchBytes(url, referer));
    }

    private static long FetchToFile(string url, string referer, string path)
    {
        Exception last = null;
        for (var attempt = 1; attempt <= 3; attempt++)
        {
            try
            {
                return FetchToFileOnce(url, referer, path);
            }
            catch (Exception error)
            {
                last = error;
                if (attempt == 3 || !IsTransientDownloadError(error)) throw;
                Thread.Sleep(400 * attempt);
            }
        }
        throw last ?? new InvalidOperationException("Download failed");
    }

    private static long FetchToFileOnce(string url, string referer, string path)
    {
        var temporary = path + ".partial";
        var request = (HttpWebRequest)WebRequest.Create(url);
        request.Method = "GET";
        request.UserAgent = "Mozilla/5.0";
        request.Referer = referer;
        request.Timeout = 120000;
        request.ReadWriteTimeout = 120000;
        request.AllowAutoRedirect = true;
        using (var response = (HttpWebResponse)request.GetResponse())
        using (var input = response.GetResponseStream())
        using (var output = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            if (input == null) throw new InvalidOperationException("Empty media response");
            input.CopyTo(output);
        }
        if (File.Exists(path)) File.Delete(path);
        File.Move(temporary, path);
        var length = new FileInfo(path).Length;
        if (length == 0) throw new InvalidOperationException("Downloaded an empty media segment");
        return length;
    }

    private static byte[] FetchBytes(string url, string referer)
    {
        Exception last = null;
        for (var attempt = 1; attempt <= 3; attempt++)
        {
            try
            {
                return FetchBytesOnce(url, referer);
            }
            catch (Exception error)
            {
                last = error;
                if (attempt == 3 || !IsTransientDownloadError(error)) throw;
                Thread.Sleep(400 * attempt);
            }
        }
        throw last ?? new InvalidOperationException("Playlist download failed");
    }

    private static byte[] FetchBytesOnce(string url, string referer)
    {
        var request = (HttpWebRequest)WebRequest.Create(url);
        request.Method = "GET";
        request.UserAgent = "Mozilla/5.0";
        request.Referer = referer;
        request.Timeout = 60000;
        request.ReadWriteTimeout = 60000;
        request.AllowAutoRedirect = true;
        using (var response = (HttpWebResponse)request.GetResponse())
        using (var input = response.GetResponseStream())
        using (var memory = new MemoryStream())
        {
            if (input == null) throw new InvalidOperationException("Empty playlist response");
            input.CopyTo(memory);
            return memory.ToArray();
        }
    }

    private static bool IsTransientDownloadError(Exception error)
    {
        var text = error.Message ?? "";
        if (text.IndexOf("401", StringComparison.OrdinalIgnoreCase) >= 0 ||
            text.IndexOf("403", StringComparison.OrdinalIgnoreCase) >= 0 ||
            text.IndexOf("404", StringComparison.OrdinalIgnoreCase) >= 0)
            return true;
        var web = error as WebException;
        if (web == null) web = error.InnerException as WebException;
        if (web == null) return false;
        if (web.Status == WebExceptionStatus.Timeout ||
            web.Status == WebExceptionStatus.ConnectFailure ||
            web.Status == WebExceptionStatus.ReceiveFailure ||
            web.Status == WebExceptionStatus.KeepAliveFailure ||
            web.Status == WebExceptionStatus.ConnectionClosed ||
            web.Status == WebExceptionStatus.NameResolutionFailure)
            return true;
        var response = web.Response as HttpWebResponse;
        if (response == null) return false;
        var code = (int)response.StatusCode;
        return code == 401 || code == 403 || code == 408 || code == 429 || code >= 500;
    }

    private static void RunFfmpegManifest(string mediaUrl, string referer, string output)
    {
        if (!File.Exists(FfmpegPath)) throw new FileNotFoundException("ffmpeg was not found", FfmpegPath);
        var start = new ProcessStartInfo {
            FileName = FfmpegPath,
            Arguments = "-nostdin -y -v error -referer " + Quote(referer) +
                " -user_agent " + Quote("Mozilla/5.0") + " -i " + Quote(mediaUrl) +
                " -c copy " + Quote(output),
            UseShellExecute = false,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        using (var process = Process.Start(start))
        {
            var errors = process.StandardError.ReadToEnd();
            process.WaitForExit();
            if (process.ExitCode != 0) throw new InvalidOperationException(errors.Trim());
        }
    }

    private static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    private static void DeleteIfExists(string path) { if (File.Exists(path)) File.Delete(path); }

    private static string OutputName(CaptureSession session)
    {
        var id = SafeName(session.Id);
        if (id.Length > 8) id = id.Substring(0, 8);
        return SafeName(session.Title) + " - " + session.StartedAt.ToLocalTime().ToString("yyyy-MM-dd HH-mm-ss") + " - " + id + ".mp4";
    }

    private static void WriteMetadata(CaptureSession session, DateTime? completedAt, string packagingStatus = null, string outputFile = null, string packagingError = null)
    {
        var metadata = new Dictionary<string, object> {
            { "id", session.Id }, { "title", session.Title }, { "lessonUrl", session.LessonUrl },
            { "startedAt", session.StartedAt.ToString("o") }, { "audioSegments", session.AudioCount },
            { "videoSegments", session.VideoCount }, { "manifestSegments", session.ManifestCount }
        };
        if (completedAt.HasValue) metadata["completedAt"] = completedAt.Value.ToString("o");
        if (!string.IsNullOrWhiteSpace(packagingStatus)) metadata["packagingStatus"] = packagingStatus;
        if (!string.IsNullOrWhiteSpace(outputFile)) metadata["outputFile"] = outputFile;
        if (!string.IsNullOrWhiteSpace(packagingError)) metadata["packagingError"] = packagingError;
        File.WriteAllText(Path.Combine(session.Folder, "metadata.json"), Json.Serialize(metadata), Encoding.UTF8);
    }

    private static string Text(Dictionary<string, object> data, string key, string fallback)
    {
        object value;
        return data.TryGetValue(key, out value) && value != null ? value.ToString() : fallback;
    }

    private static int ResolvePort()
    {
        int port;
        return int.TryParse(Environment.GetEnvironmentVariable("LESSON_CAPTURE_PORT"), out port) && port >= 1024 && port <= 65535
            ? port
            : 8766;
    }

    private static string SafeName(string value)
    {
        // Page titles are untrusted. Never copy a media URL or common signing
        // parameter into a filename, even if a site displays one as its title.
        value = Regex.Replace(value, @"https?://\S+", "media", RegexOptions.IgnoreCase);
        value = Regex.Replace(value, @"(?:token|signature|sig|auth|key)\s*[=:]\s*\S+", "redacted", RegexOptions.IgnoreCase);
        foreach (var invalid in Path.GetInvalidFileNameChars()) value = value.Replace(invalid, '_');
        var result = value.Replace("..", "_").Trim(' ', '.');
        return string.IsNullOrWhiteSpace(result) ? "lesson" : result.Substring(0, Math.Min(result.Length, 96));
    }

    private static void Respond(HttpListenerContext context, HttpStatusCode status, object payload)
    {
        var bytes = payload == null ? new byte[0] : Encoding.UTF8.GetBytes(Json.Serialize(payload));
        context.Response.StatusCode = (int)status;
        context.Response.ContentType = "application/json";
        context.Response.ContentLength64 = bytes.Length;
        if (bytes.Length > 0) context.Response.OutputStream.Write(bytes, 0, bytes.Length);
        context.Response.Close();
    }
}
