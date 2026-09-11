package com.clawbench.app;

import java.util.Base64;

/**
 * Owns the lifecycle of the Tailcat transport behind the app's "Tailcat" connection
 * mode: address validation, start/stop, the loopback address the WebView loads, a
 * small state machine and typed error codes.
 *
 * <p>The Tailcat address is a {@code "tc…"} ConnBlob — a bearer transport credential.
 * This class therefore never puts it on a log line, and redacts it out of any
 * exception message it stores.
 *
 * <p>The actual TCP forwarding happens inside the Go bridge
 * ({@code tailcat.ProxyConns}); this class only drives it. All state changes happen
 * under {@link #lock}, so the methods may be called from any thread.
 */
public class TailcatManager {

    /** Never configured, or explicitly turned off. */
    public static final String STATE_DISABLED = "disabled";
    /** Between accepting a start request and the transport reporting an address. */
    public static final String STATE_STARTING = "starting";
    /** Transport is up and {@link #getLocalAddress()} is loadable. */
    public static final String STATE_RUNNING = "running";
    /** Transport was up and has been torn down cleanly. */
    public static final String STATE_STOPPED = "stopped";
    /** Last operation failed; see {@link #getErrorType()}. */
    public static final String STATE_ERROR = "error";

    public static final String ERR_NONE = "";
    public static final String ERR_EMPTY_ADDRESS = "empty_address";
    public static final String ERR_BAD_PREFIX = "bad_prefix";
    public static final String ERR_BAD_ENCODING = "bad_encoding";
    public static final String ERR_BAD_PORT = "bad_port";
    public static final String ERR_START_FAILED = "start_failed";
    public static final String ERR_STOP_FAILED = "stop_failed";
    public static final String ERR_NOT_RUNNING = "not_running";

    /** ConnBlobs are {@code "tc" + base64url(CBOR)}. */
    static final String BLOB_PREFIX = "tc";
    /**
     * A 32-byte node key plus a region id already encodes well past this, so a
     * shorter body cannot be a real blob.
     */
    static final int MIN_BODY_LEN = 16;
    /** Bound the input so pasting a whole file cannot reach the native layer. */
    static final int MAX_BODY_LEN = 8192;

    /** The slice of the gomobile binding this class actually uses. */
    public interface Transport {
        /**
         * Opens the loopback listener and returns its {@code "host:port"} address.
         * A {@code localPort} of 0 lets the OS pick a free port.
         */
        String start(String address, int serverPort, int localPort) throws Exception;

        /** Releases the listener and the underlying client. Must be idempotent. */
        void stop() throws Exception;
    }

    /**
     * Production transport: delegates to the gomobile binding.
     *
     * <p>Kept as its own class so unit tests never load it — touching
     * {@code tailcatbridge.*} is what pulls in {@code libgojni.so}, which a JVM test
     * cannot provide.
     */
    static final class GomobileTransport implements Transport {
        private tailcatbridge.Forwarder forwarder;

        @Override
        public String start(String address, int serverPort, int localPort) throws Exception {
            tailcatbridge.Forwarder f =
                    tailcatbridge.Tailcatbridge.start(address, serverPort, localPort);
            forwarder = f;
            return f.localAddress();
        }

        @Override
        public void stop() throws Exception {
            tailcatbridge.Forwarder f = forwarder;
            forwarder = null;
            if (f != null) {
                f.stop();
            }
        }
    }

    private final Transport transport;
    private final Object lock = new Object();

    private String state = STATE_DISABLED;
    private String errorCode = ERR_NONE;
    private String errorMessage = "";
    private String localAddress = "";
    private String activeAddress = "";
    private int activeServerPort;

    public TailcatManager() {
        this(new GomobileTransport());
    }

    /** Test seam: inject a transport that does not need the native library. */
    TailcatManager(Transport transport) {
        if (transport == null) {
            throw new IllegalArgumentException("transport == null");
        }
        this.transport = transport;
    }

    /**
     * Checks the shape of a Tailcat address without touching the network or the
     * native library. Returns {@link #ERR_NONE} when acceptable, otherwise an
     * {@code ERR_*} code.
     *
     * <p>This mirrors the first two steps of tailcat's own parser — strip the
     * {@code "tc"} prefix, then base64url-decode the remainder. Decoding the CBOR
     * payload is left to the native side, which reports it as a start failure.
     */
    public static String validateAddress(String raw) {
        if (raw == null) {
            return ERR_EMPTY_ADDRESS;
        }
        String s = raw.trim();
        if (s.isEmpty()) {
            return ERR_EMPTY_ADDRESS;
        }
        if (!s.startsWith(BLOB_PREFIX)) {
            return ERR_BAD_PREFIX;
        }
        String body = s.substring(BLOB_PREFIX.length());
        if (body.length() < MIN_BODY_LEN || body.length() > MAX_BODY_LEN) {
            return ERR_BAD_ENCODING;
        }
        for (int i = 0; i < body.length(); i++) {
            char c = body.charAt(i);
            boolean alphabet = (c >= 'A' && c <= 'Z')
                    || (c >= 'a' && c <= 'z')
                    || (c >= '0' && c <= '9')
                    || c == '-'
                    || c == '_';
            if (!alphabet) {
                // Spelled out rather than left to the decoder because Java's URL
                // decoder tolerates a trailing '=' in some lengths, while
                // tailcat's RawURLEncoding decoder rejects every padded body.
                return ERR_BAD_ENCODING;
            }
        }
        try {
            // tailcat emits RawURLEncoding, i.e. unpadded. The MIME decoder must
            // not be used here: it rejects the body-length % 4 == 2 case that
            // RawURLEncoding produces routinely.
            if (Base64.getUrlDecoder().decode(body).length == 0) {
                return ERR_BAD_ENCODING;
            }
        } catch (IllegalArgumentException e) {
            return ERR_BAD_ENCODING;
        }
        return ERR_NONE;
    }

    /** True for a port that can be forwarded to. */
    public static boolean isValidPort(int port) {
        return port >= 1 && port <= 65535;
    }

    /**
     * Validates the address and brings the transport up. Returns true when a
     * loopback address came back; false otherwise, with {@link #getErrorType()}
     * explaining why.
     *
     * <p>Note that a true return only means the listener is open. The Tailcat
     * handshake is lazy, so reachability still has to be probed separately before
     * the WebView is pointed at the address.
     *
     * @param localPort 0 to let the OS pick a free port
     */
    public boolean start(String address, int serverPort, int localPort) {
        String trimmed = address == null ? "" : address.trim();

        String code = validateAddress(trimmed);
        if (!ERR_NONE.equals(code)) {
            synchronized (lock) {
                failLocked(code, "invalid Tailcat address");
            }
            return false;
        }
        if (!isValidPort(serverPort)) {
            synchronized (lock) {
                failLocked(ERR_BAD_PORT, "server port out of range");
            }
            return false;
        }
        if (localPort < 0 || localPort > 65535) {
            synchronized (lock) {
                failLocked(ERR_BAD_PORT, "local port out of range");
            }
            return false;
        }

        synchronized (lock) {
            state = STATE_STARTING;
            errorCode = ERR_NONE;
            errorMessage = "";
        }

        String local;
        try {
            local = transport.start(trimmed, serverPort, localPort);
        } catch (Exception e) {
            synchronized (lock) {
                failLocked(ERR_START_FAILED, describe(e, trimmed));
            }
            return false;
        }

        if (local == null || local.trim().isEmpty()) {
            synchronized (lock) {
                failLocked(ERR_START_FAILED, "transport returned no local address");
            }
            return false;
        }

        synchronized (lock) {
            activeAddress = trimmed;
            activeServerPort = serverPort;
            localAddress = local.trim();
            state = STATE_RUNNING;
            errorCode = ERR_NONE;
            errorMessage = "";
        }
        return true;
    }

    /**
     * Tears the transport down and clears the loopback address, so a stale URL can
     * never be loaded after the tunnel is gone. Always leaves a non-running state,
     * even when the transport itself reports an error.
     */
    public boolean stop() {
        synchronized (lock) {
            if (STATE_DISABLED.equals(state) && localAddress.isEmpty()) {
                // Never started: there is nothing to release, and the state should
                // keep reading "disabled" rather than flip to "stopped".
                return true;
            }
        }

        boolean ok = true;
        String message = "";
        try {
            transport.stop();
        } catch (Exception e) {
            ok = false;
            message = describe(e, activeAddress);
        }

        synchronized (lock) {
            localAddress = "";
            if (ok) {
                state = STATE_STOPPED;
                errorCode = ERR_NONE;
                errorMessage = "";
            } else {
                failLocked(ERR_STOP_FAILED, message);
            }
        }
        return ok;
    }

    /**
     * Rebuilds the transport from the last successfully started address, reusing
     * the same loopback port so the WebView keeps a valid URL. Returns false with
     * {@link #ERR_NOT_RUNNING} when nothing has been started yet.
     */
    public boolean reconnect() {
        String address;
        int serverPort;
        int localPort;
        synchronized (lock) {
            address = activeAddress;
            serverPort = activeServerPort;
            localPort = portOf(localAddress);
        }
        if (address.isEmpty()) {
            synchronized (lock) {
                failLocked(ERR_NOT_RUNNING, "no address to reconnect with");
            }
            return false;
        }

        // Release first: the old listener still owns the port we want to reuse.
        stop();
        return start(address, serverPort, localPort);
    }

    /**
     * Drops the remembered address and remote port so nothing can rebuild the tunnel
     * from memory. This is the "forget the credential" half of removing a saved
     * Tailcat server.
     *
     * <p>Callers must {@link #stop()} first: this only clears bookkeeping and never
     * touches the transport, so skipping the stop would leave a listener running with
     * no address left to describe it. State resets to {@link #STATE_DISABLED}, which
     * also makes {@link #reconnect()} fail with {@link #ERR_NOT_RUNNING} instead of
     * quietly reviving the deleted address.
     */
    public void forget() {
        synchronized (lock) {
            activeAddress = "";
            activeServerPort = 0;
            localAddress = "";
            state = STATE_DISABLED;
            errorCode = ERR_NONE;
            errorMessage = "";
        }
    }

    /** One of the {@code STATE_*} constants. */
    public String getState() {
        synchronized (lock) {
            return state;
        }
    }

    /** True while the transport is up. */
    public boolean isRunning() {
        synchronized (lock) {
            return STATE_RUNNING.equals(state);
        }
    }

    /** One of the {@code ERR_*} constants; {@link #ERR_NONE} when all is well. */
    public String getErrorType() {
        synchronized (lock) {
            return errorCode;
        }
    }

    /** Human-readable detail for the last failure. Never contains the address. */
    public String getError() {
        synchronized (lock) {
            return errorMessage;
        }
    }

    /**
     * The {@code "host:port"} the WebView should load, or {@code ""} when the
     * transport is not running. Callers must refuse to load anything that is not a
     * loopback address.
     */
    public String getLocalAddress() {
        synchronized (lock) {
            return localAddress;
        }
    }

    /**
     * The remote ClawBench port the transport dials through the tailnet, or 0 when
     * nothing has been started.
     *
     * <p>A Tailcat address is a ConnBlob and carries no port — its CBOR payload is
     * only keys and an optional DERP region — so this has to be tracked alongside
     * the address for {@link #reconnect()} and for restoring after a process kill.
     */
    public int getServerPort() {
        synchronized (lock) {
            return activeServerPort;
        }
    }

    /** Extracts the port from a {@code "host:port"} string, or 0 when absent. */
    static int portOf(String hostPort) {
        if (hostPort == null) {
            return 0;
        }
        int colon = hostPort.lastIndexOf(':');
        if (colon < 0 || colon == hostPort.length() - 1) {
            return 0;
        }
        try {
            int port = Integer.parseInt(hostPort.substring(colon + 1).trim());
            return isValidPort(port) ? port : 0;
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private void failLocked(String code, String message) {
        state = STATE_ERROR;
        errorCode = code;
        errorMessage = message == null ? "" : message;
    }

    /** Builds a message for the last failure, with the credential stripped out. */
    private static String describe(Exception e, String secret) {
        if (e == null) {
            return "";
        }
        String m = e.getMessage();
        if (m == null || m.isEmpty()) {
            m = e.getClass().getSimpleName();
        }
        if (secret != null && !secret.isEmpty()) {
            m = m.replace(secret, "<redacted>");
        }
        return m;
    }
}
