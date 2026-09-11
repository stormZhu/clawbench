package com.clawbench.app;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for {@link TailcatManager}: address validation bounds, the state
 * machine, credential redaction, port reuse on reconnect and resource release.
 *
 * <p>These run on a plain JVM. {@link TailcatManager}'s constructor takes a
 * {@link TailcatManager.Transport}, so nothing here touches {@code tailcatbridge.*}
 * — loading that would pull in {@code libgojni.so}, which the JVM cannot provide.
 */
public class TailcatManagerTest {

    /**
     * ConnBlob samples with the three body lengths RawURLEncoding can produce.
     * Generated the way tailcat does it: "tc" + base64.RawURLEncoding(CBOR).
     * The %4 == 2 and %4 == 3 bodies carry no padding, which is the case that
     * trips up Java's MIME decoder but must pass here.
     */
    private static final String BLOB_MOD4_0 =
            "tcAwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dzj6vH4_wYNFBsiKTA3";
    private static final String BLOB_MOD4_2 =
            "tcAwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dzj6vH4_wYNFBsiKTA3Pg";
    private static final String BLOB_MOD4_3 =
            "tcAwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dzj6vH4_wYNFBsiKTA3PkU";

    private static final int SERVER_PORT = 20000;

    // =====================================================
    // validateAddress
    // =====================================================

    @Test
    public void validateAddress_null_isEmptyAddress() {
        assertEquals(TailcatManager.ERR_EMPTY_ADDRESS, TailcatManager.validateAddress(null));
    }

    @Test
    public void validateAddress_blank_isEmptyAddress() {
        assertEquals(TailcatManager.ERR_EMPTY_ADDRESS, TailcatManager.validateAddress(""));
        assertEquals(TailcatManager.ERR_EMPTY_ADDRESS, TailcatManager.validateAddress("   "));
        assertEquals(TailcatManager.ERR_EMPTY_ADDRESS, TailcatManager.validateAddress("\t\n"));
    }

    @Test
    public void validateAddress_missingTcPrefix_isBadPrefix() {
        // A 48-char base64url body with no "tc" marker.
        assertEquals(TailcatManager.ERR_BAD_PREFIX,
                TailcatManager.validateAddress("AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dzj6"));
        assertEquals(TailcatManager.ERR_BAD_PREFIX,
                TailcatManager.validateAddress("http://192.168.1.10:20000"));
    }

    @Test
    public void validateAddress_realUnpaddedBodies_areAccepted() {
        // Covers all three body lengths RawURLEncoding emits, including the two
        // that arrive without padding.
        assertEquals(TailcatManager.ERR_NONE, TailcatManager.validateAddress(BLOB_MOD4_0));
        assertEquals(TailcatManager.ERR_NONE, TailcatManager.validateAddress(BLOB_MOD4_2));
        assertEquals(TailcatManager.ERR_NONE, TailcatManager.validateAddress(BLOB_MOD4_3));
    }

    @Test
    public void validateAddress_surroundingWhitespace_isTolerated() {
        assertEquals(TailcatManager.ERR_NONE,
                TailcatManager.validateAddress("  " + BLOB_MOD4_2 + "\n"));
    }

    @Test
    public void validateAddress_paddedBody_isRejected() {
        // RawURLEncoding never pads, so trailing '=' means the blob was mangled
        // (or produced by a different encoder).
        assertEquals(TailcatManager.ERR_BAD_ENCODING,
                TailcatManager.validateAddress(BLOB_MOD4_2 + "=="));
        assertEquals(TailcatManager.ERR_BAD_ENCODING,
                TailcatManager.validateAddress(BLOB_MOD4_0 + "="));
    }

    @Test
    public void validateAddress_illegalCharacters_areRejected() {
        // Body long enough to clear the length gate, so the base64 step is what
        // rejects it.
        assertEquals(TailcatManager.ERR_BAD_ENCODING,
                TailcatManager.validateAddress("tcAAAAAAAAAAAAAAAA!A"));
        assertEquals(TailcatManager.ERR_BAD_ENCODING,
                TailcatManager.validateAddress("tcAAAAAAAA AAAAAAAAA"));
        // '+' and '/' belong to standard base64, not the URL-safe alphabet.
        assertEquals(TailcatManager.ERR_BAD_ENCODING,
                TailcatManager.validateAddress("tcAAAA+AAAAAAAAAAA/"));
    }

    @Test
    public void validateAddress_tooShortAndTooLong_areRejected() {
        assertEquals(TailcatManager.ERR_BAD_ENCODING, TailcatManager.validateAddress("tc"));
        assertEquals(TailcatManager.ERR_BAD_ENCODING, TailcatManager.validateAddress("tcAAAA"));

        StringBuilder huge = new StringBuilder("tc");
        for (int i = 0; i < 9000; i++) {
            huge.append('A');
        }
        assertEquals(TailcatManager.ERR_BAD_ENCODING, TailcatManager.validateAddress(huge.toString()));
    }

    @Test
    public void validateAddress_bodyOfOnlyPrefixLength_isRejectedByLengthGate() {
        // 15 chars of valid alphabet: decodes fine but is far too short to hold a key.
        assertEquals(TailcatManager.ERR_BAD_ENCODING,
                TailcatManager.validateAddress("tcAAAAAAAAAAAAAAA"));
    }

    @Test
    public void validateAddress_alphabetValidButUndecodable_isRejectedByDecodeStep() {
        // 17 chars: every character is in the URL-safe alphabet, but base64 cannot
        // split a length of 17 into units. Only the decode step catches this.
        assertEquals(TailcatManager.ERR_BAD_ENCODING,
                TailcatManager.validateAddress("tcAAAAAAAAAAAAAAAAA"));
    }

    // =====================================================
    // start
    // =====================================================

    @Test
    public void start_invalidAddress_failsWithoutTouchingTransport() {
        FakeTransport transport = new FakeTransport();
        TailcatManager manager = new TailcatManager(transport);

        assertFalse(manager.start("not-a-blob", SERVER_PORT, 0));

        assertNull("transport must not be started with a bad address", transport.startCalls);
        assertEquals(TailcatManager.STATE_ERROR, manager.getState());
        assertEquals(TailcatManager.ERR_BAD_PREFIX, manager.getErrorType());
        assertFalse(manager.isRunning());
        assertEquals("", manager.getLocalAddress());
    }

    @Test
    public void start_emptyAddress_reportsEmptyAddress() {
        FakeTransport transport = new FakeTransport();
        TailcatManager manager = new TailcatManager(transport);

        assertFalse(manager.start("   ", SERVER_PORT, 0));

        assertEquals(TailcatManager.ERR_EMPTY_ADDRESS, manager.getErrorType());
        assertNull(transport.startCalls);
    }

    @Test
    public void start_serverPortOutOfRange_isRejected() {
        FakeTransport transport = new FakeTransport();
        TailcatManager manager = new TailcatManager(transport);

        assertFalse(manager.start(BLOB_MOD4_2, 0, 0));
        assertEquals(TailcatManager.ERR_BAD_PORT, manager.getErrorType());

        assertFalse(manager.start(BLOB_MOD4_2, 65536, 0));
        assertEquals(TailcatManager.ERR_BAD_PORT, manager.getErrorType());

        assertNull("no network work for a rejected port", transport.startCalls);
    }

    @Test
    public void start_localPortOutOfRange_isRejected() {
        FakeTransport transport = new FakeTransport();
        TailcatManager manager = new TailcatManager(transport);

        assertFalse(manager.start(BLOB_MOD4_2, SERVER_PORT, -1));
        assertEquals(TailcatManager.ERR_BAD_PORT, manager.getErrorType());

        assertFalse(manager.start(BLOB_MOD4_2, SERVER_PORT, 65536));
        assertEquals(TailcatManager.ERR_BAD_PORT, manager.getErrorType());
    }

    @Test
    public void start_transportThrows_reportsStartFailedAndRedactsAddress() {
        FakeTransport transport = new FakeTransport();
        // A real bridge error can echo the address back; the manager must not keep it.
        transport.startFailure = new IllegalStateException("dial " + BLOB_MOD4_2 + " refused");
        TailcatManager manager = new TailcatManager(transport);

        assertFalse(manager.start(BLOB_MOD4_2, SERVER_PORT, 0));

        assertEquals(TailcatManager.STATE_ERROR, manager.getState());
        assertEquals(TailcatManager.ERR_START_FAILED, manager.getErrorType());
        assertTrue("message should survive", manager.getError().contains("refused"));
        assertFalse("credential must be redacted",
                manager.getError().contains(BLOB_MOD4_2));
        assertTrue(manager.getError().contains("<redacted>"));
        assertEquals("", manager.getLocalAddress());
    }

    @Test
    public void start_transportThrowsWithoutMessage_stillReportsSomething() {
        FakeTransport transport = new FakeTransport();
        transport.startFailure = new IllegalStateException();
        TailcatManager manager = new TailcatManager(transport);

        assertFalse(manager.start(BLOB_MOD4_2, SERVER_PORT, 0));

        assertEquals(TailcatManager.ERR_START_FAILED, manager.getErrorType());
        assertEquals("IllegalStateException", manager.getError());
    }

    @Test
    public void start_transportReturnsBlankAddress_isAFailure() {
        FakeTransport transport = new FakeTransport();
        transport.startResult = "   ";
        TailcatManager manager = new TailcatManager(transport);

        assertFalse(manager.start(BLOB_MOD4_2, SERVER_PORT, 0));

        assertEquals(TailcatManager.ERR_START_FAILED, manager.getErrorType());
        assertEquals(TailcatManager.STATE_ERROR, manager.getState());
    }

    @Test
    public void start_success_movesToRunningAndExposesLocalAddress() {
        FakeTransport transport = new FakeTransport();
        transport.startResult = "127.0.0.1:54321";
        TailcatManager manager = new TailcatManager(transport);

        assertTrue(manager.start(BLOB_MOD4_2, SERVER_PORT, 0));

        assertEquals(TailcatManager.STATE_RUNNING, manager.getState());
        assertTrue(manager.isRunning());
        assertEquals(TailcatManager.ERR_NONE, manager.getErrorType());
        assertEquals("", manager.getError());
        assertEquals("127.0.0.1:54321", manager.getLocalAddress());

        assertEquals(BLOB_MOD4_2, transport.startCalls.address);
        assertEquals(SERVER_PORT, transport.startCalls.serverPort);
        assertEquals(0, transport.startCalls.localPort);
    }

    @Test
    public void start_trimsAddressBeforeHandingItToTheTransport() {
        FakeTransport transport = new FakeTransport();
        TailcatManager manager = new TailcatManager(transport);

        assertTrue(manager.start("  " + BLOB_MOD4_2 + "  ", SERVER_PORT, 0));

        assertEquals(BLOB_MOD4_2, transport.startCalls.address);
    }

    // =====================================================
    // stop
    // =====================================================

    @Test
    public void stop_beforeAnyStart_keepsDisabledAndSkipsTransport() {
        FakeTransport transport = new FakeTransport();
        TailcatManager manager = new TailcatManager(transport);

        assertTrue(manager.stop());

        assertEquals("state should stay disabled, not become stopped",
                TailcatManager.STATE_DISABLED, manager.getState());
        assertEquals(0, transport.stopCalls);
    }

    @Test
    public void stop_afterStart_clearsLocalAddressAndReleasesTransport() {
        FakeTransport transport = new FakeTransport();
        transport.startResult = "127.0.0.1:54321";
        TailcatManager manager = new TailcatManager(transport);
        assertTrue(manager.start(BLOB_MOD4_2, SERVER_PORT, 0));

        assertTrue(manager.stop());

        assertEquals(TailcatManager.STATE_STOPPED, manager.getState());
        assertFalse(manager.isRunning());
        assertEquals("stale URL must not survive a stop", "", manager.getLocalAddress());
        assertEquals(1, transport.stopCalls);
    }

    @Test
    public void stop_transportThrows_reportsStopFailedButStillClearsAddress() {
        FakeTransport transport = new FakeTransport();
        transport.startResult = "127.0.0.1:54321";
        transport.stopFailure = new IllegalStateException("close failed");
        TailcatManager manager = new TailcatManager(transport);
        assertTrue(manager.start(BLOB_MOD4_2, SERVER_PORT, 0));

        assertFalse(manager.stop());

        assertEquals(TailcatManager.STATE_ERROR, manager.getState());
        assertEquals(TailcatManager.ERR_STOP_FAILED, manager.getErrorType());
        assertEquals("", manager.getLocalAddress());
        assertFalse(manager.isRunning());
    }

    @Test
    public void stop_isIdempotent() {
        FakeTransport transport = new FakeTransport();
        transport.startResult = "127.0.0.1:54321";
        TailcatManager manager = new TailcatManager(transport);
        assertTrue(manager.start(BLOB_MOD4_2, SERVER_PORT, 0));

        assertTrue(manager.stop());
        assertTrue(manager.stop());

        assertEquals(TailcatManager.STATE_STOPPED, manager.getState());
        assertEquals(2, transport.stopCalls);
    }

    // =====================================================
    // reconnect
    // =====================================================

    @Test
    public void reconnect_withoutAPriorStart_reportsNotRunning() {
        FakeTransport transport = new FakeTransport();
        TailcatManager manager = new TailcatManager(transport);

        assertFalse(manager.reconnect());

        assertEquals(TailcatManager.ERR_NOT_RUNNING, manager.getErrorType());
        assertNull(transport.startCalls);
    }

    @Test
    public void reconnect_reusesThePreviousLoopbackPort() {
        FakeTransport transport = new FakeTransport();
        transport.startResult = "127.0.0.1:54321";
        TailcatManager manager = new TailcatManager(transport);
        assertTrue(manager.start(BLOB_MOD4_2, SERVER_PORT, 0));

        transport.startResult = "127.0.0.1:54321";
        assertTrue(manager.reconnect());

        assertEquals("the WebView URL should stay valid across a reconnect",
                54321, transport.startCalls.localPort);
        assertEquals(BLOB_MOD4_2, transport.startCalls.address);
        assertEquals(SERVER_PORT, transport.startCalls.serverPort);
        assertEquals(TailcatManager.STATE_RUNNING, manager.getState());
        assertTrue("must tear the old listener down first", transport.stopCalls >= 1);
    }

    @Test
    public void reconnect_failureLeavesTheManagerInError() {
        FakeTransport transport = new FakeTransport();
        transport.startResult = "127.0.0.1:54321";
        TailcatManager manager = new TailcatManager(transport);
        assertTrue(manager.start(BLOB_MOD4_2, SERVER_PORT, 0));

        transport.startFailure = new IllegalStateException("relay unreachable");
        assertFalse(manager.reconnect());

        assertEquals(TailcatManager.STATE_ERROR, manager.getState());
        assertEquals(TailcatManager.ERR_START_FAILED, manager.getErrorType());
        assertEquals("", manager.getLocalAddress());
    }

    // =====================================================
    // helpers
    // =====================================================

    @Test
    public void getServerPort_isZeroUntilAStartSucceeds() {
        FakeTransport transport = new FakeTransport();
        TailcatManager manager = new TailcatManager(transport);
        assertEquals(0, manager.getServerPort());

        // A rejected start must not leave a port behind for reconnect() to reuse.
        assertFalse(manager.start("not-a-blob", SERVER_PORT, 0));
        assertEquals(0, manager.getServerPort());
    }

    @Test
    public void getServerPort_remembersTheRemotePortAcrossStopAndReconnect() {
        // A Tailcat address is a ConnBlob and carries no port, so the manager is the
        // only place the remote ClawBench port exists between commands.
        FakeTransport transport = new FakeTransport();
        TailcatManager manager = new TailcatManager(transport);

        assertTrue(manager.start(BLOB_MOD4_2, 20000, 0));
        assertEquals(20000, manager.getServerPort());

        // stop() must not forget it: reconnect() needs it to rebuild.
        assertTrue(manager.stop());
        assertEquals("the remote port is what makes a reconnect possible",
                20000, manager.getServerPort());

        assertTrue(manager.reconnect());
        assertEquals(20000, transport.startCalls.serverPort);
        assertEquals(20000, manager.getServerPort());
    }

    @Test
    public void getServerPort_isNotTheLocalPort() {
        // Guards the confusion this field exists to prevent: the local loopback port
        // and the remote ClawBench port are different numbers with different owners.
        FakeTransport transport = new FakeTransport();
        transport.startResult = "127.0.0.1:54321";
        TailcatManager manager = new TailcatManager(transport);

        assertTrue(manager.start(BLOB_MOD4_2, 20000, 0));
        assertEquals(54321, TailcatManager.portOf(manager.getLocalAddress()));
        assertEquals(20000, manager.getServerPort());
    }

    @Test
    public void portOf_parsesOnlyRealLoopbackPorts() {
        assertEquals(54321, TailcatManager.portOf("127.0.0.1:54321"));
        assertEquals(1, TailcatManager.portOf("127.0.0.1:1"));
        assertEquals(65535, TailcatManager.portOf("127.0.0.1:65535"));
        assertEquals(0, TailcatManager.portOf("127.0.0.1:"));
        assertEquals(0, TailcatManager.portOf("127.0.0.1"));
        assertEquals(0, TailcatManager.portOf("127.0.0.1:0"));
        assertEquals(0, TailcatManager.portOf("127.0.0.1:65536"));
        assertEquals(0, TailcatManager.portOf("127.0.0.1:abc"));
        assertEquals(0, TailcatManager.portOf(null));
    }

    @Test
    public void isValidPort_bounds() {
        assertFalse(TailcatManager.isValidPort(0));
        assertFalse(TailcatManager.isValidPort(-1));
        assertTrue(TailcatManager.isValidPort(1));
        assertTrue(TailcatManager.isValidPort(20000));
        assertTrue(TailcatManager.isValidPort(65535));
        assertFalse(TailcatManager.isValidPort(65536));
    }

    // =====================================================
    // forget
    // =====================================================

    @Test
    public void forget_dropsTheAddressSoReconnectCannotReviveIt() {
        // The address is a bearer credential: once the user removes it, nothing in
        // memory may rebuild the tunnel.
        FakeTransport transport = new FakeTransport();
        TailcatManager manager = new TailcatManager(transport);
        assertTrue(manager.start(BLOB_MOD4_2, 20000, 0));
        assertTrue(manager.stop());
        int startsBefore = transport.calls.size();
        int stopsBefore = transport.stopCalls;

        manager.forget();

        assertFalse(manager.isRunning());
        assertEquals(TailcatManager.STATE_DISABLED, manager.getState());
        assertEquals("", manager.getLocalAddress());
        assertEquals("the remote port must be forgotten too", 0, manager.getServerPort());

        assertFalse("a forgotten address must not reconnect", manager.reconnect());
        assertEquals(TailcatManager.ERR_NOT_RUNNING, manager.getErrorType());
        assertEquals("forget() must not touch the transport",
                startsBefore, transport.calls.size());
        assertEquals("forget() must not touch the transport",
                stopsBefore, transport.stopCalls);
    }

    @Test
    public void forget_clearsThePreviousError() {
        // Otherwise the login card would read as "the last attempt failed" right after
        // a deliberate removal.
        FakeTransport transport = new FakeTransport();
        TailcatManager manager = new TailcatManager(transport);
        assertFalse(manager.start("not-a-blob", SERVER_PORT, 0));
        assertEquals(TailcatManager.ERR_BAD_PREFIX, manager.getErrorType());

        manager.forget();

        assertEquals(TailcatManager.STATE_DISABLED, manager.getState());
        assertEquals(TailcatManager.ERR_NONE, manager.getErrorType());
        assertEquals("", manager.getError());
    }

    @Test
    public void forget_beforeAnyStart_isHarmless() {
        FakeTransport transport = new FakeTransport();
        TailcatManager manager = new TailcatManager(transport);

        manager.forget();

        assertEquals(TailcatManager.STATE_DISABLED, manager.getState());
        assertEquals(0, transport.calls.size());
        assertEquals(0, transport.stopCalls);
    }

    /** Records what the manager asked for, and fails on demand. */
    private static final class FakeTransport implements TailcatManager.Transport {
        final List<StartCall> calls = new ArrayList<>();
        StartCall startCalls;
        String startResult = "127.0.0.1:12345";
        Exception startFailure;
        Exception stopFailure;
        int stopCalls;

        @Override
        public String start(String address, int serverPort, int localPort) throws Exception {
            startCalls = new StartCall(address, serverPort, localPort);
            calls.add(startCalls);
            if (startFailure != null) {
                throw startFailure;
            }
            return startResult;
        }

        @Override
        public void stop() throws Exception {
            stopCalls++;
            if (stopFailure != null) {
                throw stopFailure;
            }
        }
    }

    private static final class StartCall {
        final String address;
        final int serverPort;
        final int localPort;

        StartCall(String address, int serverPort, int localPort) {
            this.address = address;
            this.serverPort = serverPort;
            this.localPort = localPort;
        }
    }
}
