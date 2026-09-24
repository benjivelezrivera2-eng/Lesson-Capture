using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

// Chrome Native Messaging host. It only starts and checks the local collector;
// no lesson URL, media, cookies, or account data reaches this executable.
public static class LessonCaptureLauncher
{
    private const string CollectorFileName = "LessonCaptureCollector.exe";
    private const string HealthUrl = "http://127.0.0.1:8766/health";

    public static void Main()
    {
        ReadMessage();
        string error;
        bool ready = EnsureCollector(out error);
        WriteMessage(ready
            ? "{\"ready\":true}"
            : "{\"ready\":false,\"error\":\"" + EscapeJson(error) + "\"}");
    }

    private static bool EnsureCollector(out string error)
    {
        error = null;
        if (IsHealthy()) return true;
        try
        {
            string collectorPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, CollectorFileName);
            if (!File.Exists(collectorPath))
            {
                error = "The local collector executable is missing.";
                return false;
            }
            Process.Start(new ProcessStartInfo
            {
                FileName = collectorPath,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            });
        }
        catch (Exception ex)
        {
            error = "Windows could not start the local collector: " + ex.Message;
            return false;
        }

        for (int attempt = 0; attempt < 32; attempt++)
        {
            Thread.Sleep(250);
            if (IsHealthy()) return true;
        }
        error = "The local collector did not become ready within 8 seconds.";
        return false;
    }

    private static bool IsHealthy()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(HealthUrl);
            request.Method = "GET";
            request.Timeout = 1000;
            request.ReadWriteTimeout = 1000;
            using (var response = (HttpWebResponse)request.GetResponse())
            {
                return response.StatusCode == HttpStatusCode.OK;
            }
        }
        catch { return false; }
    }

    private static void ReadMessage()
    {
        Stream input = Console.OpenStandardInput();
        byte[] lengthBytes = ReadExact(input, 4);
        if (lengthBytes == null) return;
        int length = BitConverter.ToInt32(lengthBytes, 0);
        if (length < 0 || length > 1024 * 1024) return;
        ReadExact(input, length);
    }

    private static byte[] ReadExact(Stream stream, int length)
    {
        byte[] bytes = new byte[length];
        int offset = 0;
        while (offset < length)
        {
            int read = stream.Read(bytes, offset, length - offset);
            if (read == 0) return null;
            offset += read;
        }
        return bytes;
    }

    private static void WriteMessage(string json)
    {
        byte[] body = Encoding.UTF8.GetBytes(json);
        Stream output = Console.OpenStandardOutput();
        byte[] length = BitConverter.GetBytes(body.Length);
        output.Write(length, 0, length.Length);
        output.Write(body, 0, body.Length);
        output.Flush();
    }

    private static string EscapeJson(string value)
    {
        return (value ?? "Unknown local error.").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", " ");
    }
}
