using System.Buffers.Binary;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Concentus;
using Concentus.Enums;
using RikRealization.ClassicCast.Protocol.Rtp;

if (args.Contains("--self-test")) { SelfTests.Run(); return; }
try { Run(); }
catch (Exception e) { Console.Error.WriteLine(JsonSerializer.Serialize(new { code = "EXCEPTION", exception = e.GetType().Name, socketErrorCode = e is SocketException socket ? (int?)socket.SocketErrorCode : null, nativeErrorCode = (e as SocketException)?.NativeErrorCode, socketStage = "sender" })); Environment.ExitCode = 1; }

static bool ReadBlock(Stream input, byte[] data, bool audio = false) {
    int offset = 0;
    while (offset < data.Length) {
        int count = input.Read(data.AsSpan(offset));
        if (count == 0) { if (offset != 0 && !audio) throw new EndOfStreamException(); return false; }
        offset += count;
    }
    return true;
}

static void Run() {
    using var input = Console.OpenStandardInput();
    var length = new byte[4];
    if (!ReadBlock(input, length)) return;
    int size = BinaryPrimitives.ReadInt32LittleEndian(length);
    if (size < 2 || size > 2048) throw new InvalidDataException();
    var json = new byte[size];
    if (!ReadBlock(input, json)) throw new EndOfStreamException();
    var cfg = JsonSerializer.Deserialize<SenderConfig>(json)!;
    var ip = IPAddress.Parse(cfg.Host);
    var octets = ip.GetAddressBytes();
    if (octets.Length != 4 || !(octets[0] == 127 || octets[0] == 10 || (octets[0] == 192 && octets[1] == 168) || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31))) throw new InvalidDataException();
    if (cfg.Port < 1 || cfg.Port > 65535 || cfg.DelayMs < 40 || cfg.DelayMs > 1000 || (cfg.PayloadType != 96 && cfg.PayloadType != 127)) throw new InvalidDataException();
    using var crypto = new FrameCrypto(Convert.FromHexString(cfg.Key), Convert.FromHexString(cfg.Iv));
    var transport = new CastStreamingTransport(new IPEndPoint(ip, cfg.Port));
    transport.SocketErrorReported += (error, stage, attempt, retry) => Console.Error.WriteLine(JsonSerializer.Serialize(new {
        code = retry ? "SOCKET_RETRY" : stage == "retransmit" ? "SOCKET_RETRANSMIT_FAILED" : "SOCKET_FAILURE",
        exception = "SocketException", socketErrorCode = (int)error.SocketErrorCode, nativeErrorCode = error.NativeErrorCode,
        socketStage = stage, socketAttempt = attempt
    }));
    try {
    var stream = transport.AddStream(cfg.Ssrc, cfg.PayloadType, crypto);
    using var encoder = OpusCodecFactory.CreateEncoder(48000, 2, OpusApplication.OPUS_APPLICATION_AUDIO);
    encoder.Bitrate = 128000; encoder.UseVBR = false; encoder.Complexity = 5; encoder.UseDTX = false;
    var delay = new PlayoutDelayController(TimeSpan.FromMilliseconds(cfg.DelayMs), TimeSpan.FromMilliseconds(100), TimeSpan.FromMilliseconds(1000));
    long feedbackCount = 0, nackCount = 0, lastFeedbackTick = 0, receiverDelay = 0;
    int previousCheckpoint = -1;
    stream.FeedbackReceived += f => {
        Interlocked.Increment(ref feedbackCount); Interlocked.Add(ref nackCount, f.Nacks.Count);
        Interlocked.Exchange(ref lastFeedbackTick, Stopwatch.GetTimestamp());
        if (f.PlayoutDelay is { } d) Interlocked.Exchange(ref receiverDelay, (long)d.TotalMilliseconds);
        delay.RecordFeedback(f);
        if (f.CheckpointFrameId is { } cp && cp != previousCheckpoint) { delay.RecordCheckpointAdvanced(); previousCheckpoint = cp; }
    };
    transport.StartReceiving();
    Console.WriteLine("{\"type\":\"ready\"}");
    var pcm = new byte[960 * 2 * 4]; var samples = new short[1920]; var encoded = new byte[4000];
    uint frameId = 0; long firstTick = 0; DateTimeOffset origin = default;
    double maxEncodeMs = 0, maxInputReadMs = 0, maxSendMs = 0;
    var encodeTimes = new List<double>(); var readTimes = new List<double>(); var sendTimes = new List<double>();
    while (true) {
        var readStart = Stopwatch.GetTimestamp();
        // This loop owns the main thread; anonymous-pipe reads do not queue ThreadPool work per frame.
        if (!ReadBlock(input, pcm, audio: true)) { Console.Error.WriteLine(JsonSerializer.Serialize(new { code = "INPUT_EOF", frames = frameId })); break; }
        double readBlockMs = (Stopwatch.GetTimestamp() - readStart) * 1000.0 / Stopwatch.Frequency;
        readTimes.Add(readBlockMs); maxInputReadMs = Math.Max(maxInputReadMs, readBlockMs);
        float peak = 0;
        for (int i = 0; i < samples.Length; i++) {
            float value = BitConverter.Int32BitsToSingle(BinaryPrimitives.ReadInt32LittleEndian(pcm.AsSpan(i * 4)));
            if (!float.IsFinite(value) || Math.Abs(value) > 16) throw new InvalidDataException();
            peak = Math.Max(peak, Math.Abs(value)); samples[i] = (short)Math.Clamp((int)Math.Round(value * 32767), -32768, 32767);
        }
        if (firstTick == 0) { firstTick = Stopwatch.GetTimestamp(); origin = DateTimeOffset.UtcNow.AddMilliseconds(-20); }
        double elapsedMs = (Stopwatch.GetTimestamp() - firstTick) * 1000.0 / Stopwatch.Frequency;
        double sourceClockDifferenceMs = elapsedMs - frameId * 20.0;
        // Clock offset is diagnostic; queue, blocked input and missing feedback retain their own guards.
        var encodeStart = Stopwatch.GetTimestamp();
        int count = encoder.Encode(samples.AsSpan(), 960, encoded.AsSpan(), encoded.Length);
        double encodeMs = (Stopwatch.GetTimestamp() - encodeStart) * 1000.0 / Stopwatch.Frequency;
        maxEncodeMs = Math.Max(maxEncodeMs, encodeMs); encodeTimes.Add(encodeMs);
        uint timestamp = unchecked(frameId * 960);
        var sendStart = Stopwatch.GetTimestamp();
        if (frameId % 10 == 0) stream.SendSenderReportAsync(timestamp, origin.AddMilliseconds(frameId * 20.0)).GetAwaiter().GetResult();
        TimeSpan change = frameId == 0 ? TimeSpan.FromMilliseconds(cfg.DelayMs) : TimeSpan.Zero;
        if (cfg.Adaptive && frameId % 50 == 0 && frameId > 0) change = delay.Tick() ?? TimeSpan.Zero;
        stream.SendFrameAsync(new EncodedFrame { FrameId = frameId, ReferencedFrameId = frameId, IsKeyFrame = true, RtpTimestamp = timestamp, Data = encoded.AsMemory(0, count), NewPlayoutDelay = change }).GetAwaiter().GetResult();
        double sendMs = (Stopwatch.GetTimestamp() - sendStart) * 1000.0 / Stopwatch.Frequency;
        sendTimes.Add(sendMs); maxSendMs = Math.Max(maxSendMs, sendMs);
        delay.RecordFrameSent(); frameId++;
        if (frameId % 50 == 0) {
            double feedbackAge = lastFeedbackTick == 0 ? elapsedMs : (Stopwatch.GetTimestamp() - Interlocked.Read(ref lastFeedbackTick)) * 1000.0 / Stopwatch.Frequency;
            encodeTimes.Sort();
            readTimes.Sort(); sendTimes.Sort();
            Console.WriteLine(JsonSerializer.Serialize(new { type = "stats", frames = frameId, packets = stream.PacketsSent, retransmitted = stream.RetransmittedPackets, feedback = Interlocked.Read(ref feedbackCount), nacks = Interlocked.Read(ref nackCount), checkpoint = stream.LastCheckpointFrameId, receiverDelayMs = Interlocked.Read(ref receiverDelay), targetDelayMs = delay.Current.TotalMilliseconds, adaptive = cfg.Adaptive, encodeP50Ms = encodeTimes[24], encodeP95Ms = encodeTimes[47], encodeP99Ms = encodeTimes[49], maxEncodeMs, inputReadP95Ms = readTimes[47], maxInputReadMs, sendP95Ms = sendTimes[47], maxSendMs, feedbackAgeMs = feedbackAge, sourceClockDifferenceMs, peak }));
            encodeTimes.Clear(); readTimes.Clear(); sendTimes.Clear();
            if (feedbackAge > 5000) {
                Console.Error.WriteLine(JsonSerializer.Serialize(new { code = "FEEDBACK_TIMEOUT", frames = frameId, feedbackAgeMs = feedbackAge, readBlockMs }));
                throw new TimeoutException();
            }
        }
    }
    } finally { transport.DisposeAsync().AsTask().GetAwaiter().GetResult(); }
}

record SenderConfig(string Host, int Port, uint Ssrc, string Key, string Iv, int DelayMs, bool Adaptive, int PayloadType = 96);
