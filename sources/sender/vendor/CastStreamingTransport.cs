using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;

namespace RikRealization.ClassicCast.Protocol.Rtp;

/// <summary>
/// The UDP side of a Cast Streaming session.
///
/// Negotiation yields exactly one port for the whole session, so audio and video share a
/// socket and are told apart by SSRC. This owns that socket, serialises writes across
/// streams, and routes the receiver's feedback back to whichever stream it concerns.
/// </summary>
public sealed class CastStreamingTransport : IAsyncDisposable
{
    private readonly Socket _socket;
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly ConcurrentDictionary<uint, CastRtpStream> _streams = new();
    private readonly CancellationTokenSource _cts = new();

    private Task? _receiveLoop;
    private bool _disposed;

    public CastStreamingTransport(IPEndPoint destination)
    {
        Destination = destination;

        _socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
        _socket.Bind(new IPEndPoint(IPAddress.Any, 0));

        // Connecting fixes the peer, so the receiver's RTCP comes back to this same local
        // port and Send/Receive can be used instead of SendTo/ReceiveFrom.
        _socket.Connect(destination);
    }

    public IPEndPoint Destination { get; }
    public IPEndPoint LocalEndPoint => (IPEndPoint)_socket.LocalEndPoint!;

    public IReadOnlyCollection<CastRtpStream> Streams => _streams.Values.ToArray();

    /// <summary>Feedback that named an SSRC we do not have a stream for.</summary>
    public event Action<CastReceiverFeedback>? UnroutedFeedback;
    public event Action<SocketException, string, int, bool>? SocketErrorReported;

    public CastRtpStream AddStream(uint ssrc, int payloadType, FrameCrypto crypto)
    {
        var stream = new CastRtpStream(this, ssrc, payloadType, crypto);

        if (!_streams.TryAdd(ssrc, stream))
            throw new InvalidOperationException($"A stream with SSRC {ssrc} already exists.");

        return stream;
    }

    public void StartReceiving() =>
        _receiveLoop ??= Task.Run(() => ReceiveLoopAsync(_cts.Token));

    /// <summary>
    /// Writes one datagram. Serialised because several streams share the socket and a
    /// frame's packets must not be interleaved with another stream's mid-burst.
    /// </summary>
    internal async Task SendAsync(byte[] packet, CancellationToken ct)
    {
        await _sendLock.WaitAsync(ct);
        try
        {
            await SendDatagramAsync(() => _socket.SendAsync(packet, SocketFlags.None, ct), "send-report", SocketErrorReported, ct);
        }
        finally
        {
            _sendLock.Release();
        }
    }

    /// <summary>Sends a group of packets without letting another stream interleave.</summary>
    internal async Task SendBatchAsync(
        IReadOnlyList<byte[]> packets, Action<int> onSent, CancellationToken ct, string stage = "send-audio")
    {
        await _sendLock.WaitAsync(ct);
        try
        {
            foreach (var packet in packets)
            {
                await SendDatagramAsync(() => _socket.SendAsync(packet, SocketFlags.None, ct), stage, SocketErrorReported, ct);
                onSent(packet.Length);
            }
        }
        finally
        {
            _sendLock.Release();
        }
    }

    internal static async ValueTask SendDatagramAsync(Func<ValueTask<int>> send, string stage,
        Action<SocketException, string, int, bool>? report, CancellationToken ct)
    {
        for (int attempt = 1; ; attempt++)
        {
            ct.ThrowIfCancellationRequested();
            try { await send(); return; }
            catch (SocketException error)
            {
                bool retry = attempt < 3 && error.SocketErrorCode is SocketError.WouldBlock or SocketError.NoBufferSpaceAvailable;
                report?.Invoke(error, stage, attempt, retry);
                if (!retry) throw;
                // Retry only local resource pressure; never reset clocks or skip the pending datagram.
                await Task.Delay(10, ct);
            }
        }
    }

    private async Task ReceiveLoopAsync(CancellationToken ct)
    {
        var buffer = new byte[CastRtpPacketizer.MaxPacketSizeIpv4];

        while (!ct.IsCancellationRequested)
        {
            int received;
            try
            {
                received = await _socket.ReceiveAsync(buffer, SocketFlags.None, ct);
            }
            catch (OperationCanceledException) { return; }
            catch (ObjectDisposedException) { return; }
            catch (SocketException) { continue; }

            var packet = buffer.AsMemory(0, received);
            if (!RtcpSenderReport.IsRtcp(packet.Span)) continue;

            var feedback = CastRtcpParser.Parse(packet.Span);

            // Feedback names the media SSRC it is about, which is how one socket carrying
            // both streams stays unambiguous.
            if (feedback.MediaSsrc is { } ssrc && _streams.TryGetValue(ssrc, out var stream))
            {
                await stream.HandleFeedbackAsync(feedback, ct);
            }
            else if (feedback.MediaSsrc is null && _streams.Count == 1 && feedback.HasFeedback)
            {
                // Older receivers may omit the SSRC. With a single stream there is no
                // ambiguity, so route it rather than dropping useful feedback.
                await _streams.Values.First().HandleFeedbackAsync(feedback, ct);
            }
            else
            {
                UnroutedFeedback?.Invoke(feedback);
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;

        _cts.Cancel();
        _socket.Dispose();

        if (_receiveLoop is not null)
        {
            try { await _receiveLoop; }
            catch (OperationCanceledException) { }
        }

        _cts.Dispose();
        _sendLock.Dispose();
    }
}
