package com.clawbench.app;

import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for {@link TailcatService}: command dispatch, the connectivity decision,
 * the notification status mapping and the preference contract.
 *
 * <p>The service itself is not instantiated — {@link TailcatService#applyCommand} and
 * {@link TailcatService#shouldReconnectOnNetworkChange} are static by design so the
 * logic can be exercised on a plain JVM, with a real {@link TailcatManager} driven by a
 * fake transport.
 */
public class TailcatServiceTest {

    /** Valid ConnBlobs (RawURLEncoding, %4 == 2 and %4 == 3 bodies). */
    private static final String BLOB_A =
            "tcAwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dzj6vH4_wYNFBsiKTA3Pg";
    private static final String BLOB_B =
            "tcAwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dzj6vH4_wYNFBsiKTA3PkU";

    private static final int SERVER_PORT = 20000;

    private FakeTransport transport;
    private TailcatManager manager;

    @Before
    public void setUp() {
        transport = new FakeTransport();
        manager = new TailcatManager(transport);
    }

    // =====================================================
    // applyCommand
    // =====================================================

    @Test
    public void applyCommand_start_bringsTheTransportUp() {
        assertTrue(TailcatService.applyCommand(
                TailcatService.ACTION_START, BLOB_A, SERVER_PORT, 0, manager));

        assertTrue(manager.isRunning());
        assertEquals(BLOB_A, transport.lastAddress);
        assertEquals(SERVER_PORT, transport.lastServerPort);
        assertEquals(0, transport.lastLocalPort);
        assertEquals("a fresh start must not tear anything down first",
                java.util.Collections.singletonList("start"), transport.events);
        assertEquals(1, transport.startCount);
        assertEquals(0, transport.stopCount);
    }

    @Test
    public void applyCommand_rotate_releasesTheOldTransportBeforeStartingTheNewOne() {
        assertTrue(TailcatService.applyCommand(
                TailcatService.ACTION_START, BLOB_A, SERVER_PORT, 0, manager));
        transport.reset();

        assertTrue(TailcatService.applyCommand(
                TailcatService.ACTION_ROTATE, BLOB_B, SERVER_PORT, 0, manager));

        // Order matters: the old listener owns the loopback port until it is closed.
        assertEquals(java.util.Arrays.asList("stop", "start"), transport.events);
        assertEquals(BLOB_B, transport.lastAddress);
        assertTrue(manager.isRunning());
    }

    @Test
    public void applyCommand_reconnect_reusesTheLoopbackPort() {
        assertTrue(TailcatService.applyCommand(
                TailcatService.ACTION_START, BLOB_A, SERVER_PORT, 0, manager));
        transport.startResult = "127.0.0.1:54321";
        transport.reset();

        assertTrue(TailcatService.applyCommand(
                TailcatService.ACTION_RECONNECT, null, 0, 0, manager));

        assertEquals(54321, transport.lastLocalPort);
        assertEquals(BLOB_A, transport.lastAddress);
        assertTrue(manager.isRunning());
    }

    @Test
    public void applyCommand_stop_takesTheTransportDown() {
        assertTrue(TailcatService.applyCommand(
                TailcatService.ACTION_START, BLOB_A, SERVER_PORT, 0, manager));

        assertTrue(TailcatService.applyCommand(
                TailcatService.ACTION_STOP, null, 0, 0, manager));

        assertFalse(manager.isRunning());
        assertEquals(TailcatManager.STATE_STOPPED, manager.getState());
        assertEquals("", manager.getLocalAddress());
        assertEquals(1, transport.stopCount);
    }

    @Test
    public void applyCommand_forget_stopsThenDropsTheRememberedAddress() {
        assertTrue(TailcatService.applyCommand(
                TailcatService.ACTION_START, BLOB_A, SERVER_PORT, 0, manager));
        transport.reset();

        assertTrue(TailcatService.applyCommand(
                TailcatService.ACTION_FORGET, null, 0, 0, manager));

        // Order matters: forget() only clears bookkeeping, so stopping afterwards
        // would leave a listener running with no address to describe it.
        assertEquals(java.util.Collections.singletonList("stop"), transport.events);
        assertEquals(1, transport.stopCount);
        assertFalse(manager.isRunning());
        assertEquals(TailcatManager.STATE_DISABLED, manager.getState());
        assertEquals("", manager.getLocalAddress());
        assertEquals("the remote port must be forgotten too", 0, manager.getServerPort());

        // The blob is gone, so a later reconnect must not revive it. The action is
        // still recognised (that is what applyCommand reports); the manager refuses it.
        assertTrue(TailcatService.applyCommand(
                TailcatService.ACTION_RECONNECT, null, 0, 0, manager));
        assertEquals(TailcatManager.ERR_NOT_RUNNING, manager.getErrorType());
        assertEquals("reconnect must not have started anything", 0, transport.startCount);
    }

    @Test
    public void applyCommand_forgetWithoutAStart_doesNotTouchTheTransport() {
        assertTrue(TailcatService.applyCommand(
                TailcatService.ACTION_FORGET, null, 0, 0, manager));

        // stop() on a never-started manager is a no-op, so nothing reaches the bridge.
        assertEquals(0, transport.startCount);
        assertEquals(0, transport.stopCount);
        assertEquals(TailcatManager.STATE_DISABLED, manager.getState());
    }

    @Test
    public void applyCommand_unknownOrMissingAction_isNotHandled() {
        assertFalse(TailcatService.applyCommand(
                "NOT_A_REAL_ACTION", null, 0, 0, manager));
        assertFalse(TailcatService.applyCommand(null, null, 0, 0, manager));

        assertEquals("nothing should have touched the transport", 0, transport.startCount);
        assertEquals(0, transport.stopCount);
    }

    @Test
    public void applyCommand_startWithBadAddress_surfacesTheErrorAndDoesNotRun() {
        assertTrue(TailcatService.applyCommand(
                TailcatService.ACTION_START, "not-a-blob", SERVER_PORT, 0, manager));

        // The action was recognised, but the manager refused it.
        assertFalse(manager.isRunning());
        assertEquals(TailcatManager.ERR_BAD_PREFIX, manager.getErrorType());
        assertEquals(0, transport.startCount);
    }

    // =====================================================
    // shouldReconnectOnNetworkChange
    // =====================================================

    @Test
    public void networkChange_ignoredWhileTheRegistrationCallbackSettles() {
        // registerDefaultNetworkCallback fires immediately on registration; that is
        // not a real network change and must not trigger a reconnect.
        assertFalse(TailcatService.shouldReconnectOnNetworkChange(
                0, TailcatManager.STATE_RUNNING, TailcatManager.ERR_NONE));
        assertFalse(TailcatService.shouldReconnectOnNetworkChange(
                TailcatService.NETWORK_SETTLE_MS - 1,
                TailcatManager.STATE_RUNNING, TailcatManager.ERR_NONE));
    }

    @Test
    public void networkChange_reconnectsWhenTheTransportWasUp() {
        assertTrue(TailcatService.shouldReconnectOnNetworkChange(
                TailcatService.NETWORK_SETTLE_MS, TailcatManager.STATE_RUNNING,
                TailcatManager.ERR_NONE));
    }

    @Test
    public void networkChange_reconnectsAfterARetryableFailure() {
        assertTrue(TailcatService.shouldReconnectOnNetworkChange(
                TailcatService.NETWORK_SETTLE_MS, TailcatManager.STATE_ERROR,
                TailcatManager.ERR_START_FAILED));
    }

    @Test
    public void networkChange_ignoresStateThatHasNothingToBringBack() {
        long settled = TailcatService.NETWORK_SETTLE_MS;

        // Never started: a new network changes nothing.
        assertFalse(TailcatService.shouldReconnectOnNetworkChange(
                settled, TailcatManager.STATE_ERROR, TailcatManager.ERR_NOT_RUNNING));
        assertFalse(TailcatService.shouldReconnectOnNetworkChange(
                settled, TailcatManager.STATE_DISABLED, TailcatManager.ERR_NONE));
        assertFalse(TailcatService.shouldReconnectOnNetworkChange(
                settled, TailcatManager.STATE_STOPPED, TailcatManager.ERR_NONE));
        // A bad address will not become good on another network. Every address
        // error is permanent, so the decision must be an allow-list, not
        // "anything but not_running".
        assertFalse(TailcatService.shouldReconnectOnNetworkChange(
                settled, TailcatManager.STATE_ERROR, TailcatManager.ERR_BAD_PREFIX));
        assertFalse(TailcatService.shouldReconnectOnNetworkChange(
                settled, TailcatManager.STATE_ERROR, TailcatManager.ERR_BAD_ENCODING));
        assertFalse(TailcatService.shouldReconnectOnNetworkChange(
                settled, TailcatManager.STATE_ERROR, TailcatManager.ERR_EMPTY_ADDRESS));
        assertFalse(TailcatService.shouldReconnectOnNetworkChange(
                settled, TailcatManager.STATE_ERROR, TailcatManager.ERR_BAD_PORT));
        // A failed stop leaves a transport we were trying to tear down; bringing
        // it back is not what the user asked for.
        assertFalse(TailcatService.shouldReconnectOnNetworkChange(
                settled, TailcatManager.STATE_ERROR, TailcatManager.ERR_STOP_FAILED));
    }

    @Test
    public void networkChange_retryableErrorsAreExactlyStartFailed() {
        // Pin the allow-list so a future refactor cannot quietly widen it back to
        // "every error except not_running".
        for (String err : new String[] {
                TailcatManager.ERR_NONE,
                TailcatManager.ERR_EMPTY_ADDRESS,
                TailcatManager.ERR_BAD_PREFIX,
                TailcatManager.ERR_BAD_ENCODING,
                TailcatManager.ERR_BAD_PORT,
                TailcatManager.ERR_STOP_FAILED,
                TailcatManager.ERR_NOT_RUNNING,
        }) {
            assertFalse("error " + err + " must not trigger a reconnect",
                    TailcatService.shouldReconnectOnNetworkChange(
                            TailcatService.NETWORK_SETTLE_MS,
                            TailcatManager.STATE_ERROR, err));
        }
        assertTrue("start_failed is the one retryable error",
                TailcatService.shouldReconnectOnNetworkChange(
                        TailcatService.NETWORK_SETTLE_MS,
                        TailcatManager.STATE_ERROR, TailcatManager.ERR_START_FAILED));
    }

    // =====================================================
    // Notification mapping
    // =====================================================

    @Test
    public void statusTextRes_mapsEveryState() {
        assertEquals(R.string.notif_tailcat_connected,
                TailcatService.statusTextRes(TailcatManager.STATE_RUNNING));
        assertEquals(R.string.notif_tailcat_connecting,
                TailcatService.statusTextRes(TailcatManager.STATE_STARTING));
        assertEquals(R.string.notif_tailcat_error,
                TailcatService.statusTextRes(TailcatManager.STATE_ERROR));
        assertEquals(R.string.notif_tailcat_stopped,
                TailcatService.statusTextRes(TailcatManager.STATE_STOPPED));
        assertEquals("an unconfigured transport reads as stopped",
                R.string.notif_tailcat_stopped,
                TailcatService.statusTextRes(TailcatManager.STATE_DISABLED));
    }

    // =====================================================
    // Preference and notification contract
    // =====================================================

    @Test
    public void preferenceKeys_areDistinct() {
        String[] keys = {
                TailcatService.KEY_SERVER_TRANSPORT,
                TailcatService.KEY_SERVER_INPUT_URL,
                TailcatService.KEY_TAILCAT_ADDRESS,
                TailcatService.KEY_LOCAL_WEBVIEW_URL,
                TailcatService.KEY_TAILCAT_LOCAL_PORT,
                TailcatService.KEY_TAILCAT_SERVER_PORT,
        };
        for (int i = 0; i < keys.length; i++) {
            for (int j = i + 1; j < keys.length; j++) {
                assertNotEquals("duplicate preference key", keys[i], keys[j]);
            }
        }
    }

    @Test
    public void transportValues_doNotCollideWithEachOther() {
        assertNotEquals(TailcatService.TRANSPORT_HTTP, TailcatService.TRANSPORT_TAILCAT);
    }

    @Test
    public void notificationId_doesNotClashWithTheOtherServices() {
        // BackgroundService uses 2, its event notifications 3, LiveUpdateManager 100.
        assertNotEquals(2, TailcatService.NOTIFICATION_ID);
        assertNotEquals(3, TailcatService.NOTIFICATION_ID);
        assertNotEquals(100, TailcatService.NOTIFICATION_ID);
    }

    // =====================================================

    /** Records the transport calls in order, and fails on demand. */
    private static final class FakeTransport implements TailcatManager.Transport {
        final List<String> events = new ArrayList<>();
        String startResult = "127.0.0.1:54321";
        String lastAddress;
        int lastServerPort;
        int lastLocalPort;
        int startCount;
        int stopCount;

        @Override
        public String start(String address, int serverPort, int localPort) {
            events.add("start");
            startCount++;
            lastAddress = address;
            lastServerPort = serverPort;
            lastLocalPort = localPort;
            return startResult;
        }

        @Override
        public void stop() {
            events.add("stop");
            stopCount++;
        }

        void reset() {
            events.clear();
            startCount = 0;
            stopCount = 0;
        }
    }
}
