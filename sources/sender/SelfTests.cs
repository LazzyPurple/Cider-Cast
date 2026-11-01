using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Net.Sockets;
using Concentus;
using Concentus.Enums;
using RikRealization.ClassicCast.Protocol.Rtp;

static class SelfTests {
    static void Check(bool value, string label) { if (!value) throw new Exception(label); }
    public static void Run() {
        SocketSendTests().GetAwaiter().GetResult();
        var key = Convert.FromHexString("040d756791711fd3adb939066e6d8690");
        var mask = Convert.FromHexString("9ff0f022a959150e70a2d05a6c184aed");
        using var crypto = new FrameCrypto(key, mask);
        var nonce = mask.ToArray(); var frameBytes = new byte[] { 1, 2, 3, 4 };
        for (int i = 0; i < 4; i++) nonce[8 + i] ^= frameBytes[i];
        using var aes = Aes.Create(); aes.Key = key;
        Check(crypto.Encrypt(0x01020304, new byte[16]).SequenceEqual(aes.EncryptEcb(nonce, PaddingMode.None)), "Cast nonce / AES");
        var data = Enumerable.Range(0, 4000).Select(i => (byte)i).ToArray();
        Check(crypto.Decrypt(257, crypto.Encrypt(257, data)).SequenceEqual(data), "multiblock crypto");
        var packetizer = new CastRtpPacketizer(127, 42);
        var frame = new EncodedFrame { FrameId = 257, ReferencedFrameId = 257, IsKeyFrame = true, RtpTimestamp = 48000, Data = data, NewPlayoutDelay = TimeSpan.FromMilliseconds(400) };
        var packets = Enumerable.Range(0, packetizer.ComputePacketCount(data.Length)).Select(i => packetizer.GeneratePacket(frame, data, i, packetizer.ComputePacketCount(data.Length))).ToArray();
        Check(packets[0][12] == 0xc1 && packets[0][13] == 1 && packets[0][18] == 1 && packets[0][19] == 4 && packets[0][20] == 2 && BinaryPrimitives.ReadUInt16BigEndian(packets[0].AsSpan(21)) == 400, "Cast header and latency extension");
        Check(packets.SelectMany((p, i) => p.Skip(i == 0 ? 23 : 19)).SequenceEqual(data), "packet fragmentation");
        var sr = RtcpSenderReport.Build(42, DateTimeOffset.UnixEpoch.AddMilliseconds(500), 48000, 1, 320);
        Check(sr.Length == 28 && sr[1] == 200 && BinaryPrimitives.ReadUInt64BigEndian(sr.AsSpan(8)) == 0x83aa7e8080000000, "NTP sender report");
        var fb = Convert.FromHexString("8fce00050000002b0000002a434153540501019004000002");
        var parsed = CastRtcpParser.Parse(fb);
        Check(parsed.MediaSsrc == 42 && parsed.CheckpointFrameId == 5 && parsed.PlayoutDelay?.TotalMilliseconds == 400 && parsed.Nacks.Count == 2 && parsed.Nacks[1].PacketId == 2, "feedback and NACK bitmask");
        Check(!CastRtcpParser.Parse(fb.AsSpan(0, 20)).HasFeedback, "truncated feedback");
        using var encoder = OpusCodecFactory.CreateEncoder(48000, 2, OpusApplication.OPUS_APPLICATION_AUDIO);
        using var decoder = OpusCodecFactory.CreateDecoder(48000, 2);
        encoder.Bitrate = 128000; encoder.UseVBR = false;
        var input = new short[1920]; for (int i = 0; i < 960; i++) input[i * 2] = input[i * 2 + 1] = (short)(Math.Sin(i * 2 * Math.PI * 440 / 48000) * 3000);
        var opus = new byte[4000]; int n = encoder.Encode(input.AsSpan(), 960, opus.AsSpan(), opus.Length);
        var decoded = new short[1920]; int samples = decoder.Decode(opus.AsSpan(0, n), decoded.AsSpan(), 960, false);
        Check(n == 320 && samples == 960 && decoded.Any(v => Math.Abs((int)v) > 100), "Opus synthetic audio roundtrip");
        Console.WriteLine("PASS: bounded socket retries/cancellation/fatal errors, crypto, RTP fragmentation/wrap/latency, NTP, feedback/NACK/truncation, Opus stereo decode.");
    }

    static async Task SocketSendTests() {
        foreach (var code in new[] { SocketError.WouldBlock, SocketError.NoBufferSpaceAvailable }) {
            foreach (var stage in new[] { "send-audio", "send-report", "retransmit" }) {
                int calls = 0;
                var reports = new List<int>(); var sent = new List<byte>();
                foreach (byte packet in new byte[] { 1, 2, 3 }) {
                    int failures = 0;
                    await CastStreamingTransport.SendDatagramAsync(() => {
                        calls++;
                        if (failures++ < 2) return ValueTask.FromException<int>(new SocketException((int)code));
                        sent.Add(packet); return ValueTask.FromResult(1);
                    }, stage, (error, where, attempt, retry) => {
                        Check(where == stage && error.SocketErrorCode == code && retry, "retry diagnostic"); reports.Add(attempt);
                    }, default);
                }
                Check(calls == 9 && sent.SequenceEqual(new byte[] { 1, 2, 3 }), "retry preserves packet and order");
                Check(reports.SequenceEqual(new[] { 1, 2, 1, 2, 1, 2 }), "two retries per packet");
            }
        }
        foreach (var code in new[] { SocketError.NoBufferSpaceAvailable, SocketError.ConnectionReset, SocketError.NetworkUnreachable, SocketError.TimedOut, SocketError.OperationAborted, SocketError.MessageSize }) {
            int calls = 0; var reports = new List<bool>(); var failure = new SocketException((int)code);
            try {
                await CastStreamingTransport.SendDatagramAsync(() => { calls++; return ValueTask.FromException<int>(failure); },
                    "send-audio", (error, stage, attempt, retry) => reports.Add(retry), default);
                throw new Exception("socket failure hidden");
            } catch (SocketException error) {
                Check(ReferenceEquals(error, failure), "original socket error preserved");
                Check(calls == (code == SocketError.NoBufferSpaceAvailable ? 3 : 1), "persistent and unknown errors stay bounded");
                Check(!reports.Last(), "fatal attempt diagnostic");
            }
        }
        using var cancel = new CancellationTokenSource(); int canceledCalls = 0;
        try {
            await CastStreamingTransport.SendDatagramAsync(() => { canceledCalls++; return ValueTask.FromException<int>(new SocketException((int)SocketError.WouldBlock)); },
                "send-report", (error, stage, attempt, retry) => cancel.Cancel(), cancel.Token);
            throw new Exception("cancellation hidden");
        } catch (OperationCanceledException) { Check(canceledCalls == 1, "close cancels retry delay"); }
        try {
            await CastStreamingTransport.SendDatagramAsync(() => { canceledCalls++; return ValueTask.FromResult(1); }, "send-report", null, cancel.Token);
            throw new Exception("canceled packet sent");
        } catch (OperationCanceledException) { Check(canceledCalls == 1, "closed transport sends nothing"); }
    }
}
