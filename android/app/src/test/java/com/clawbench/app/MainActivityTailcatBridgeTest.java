package com.clawbench.app;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import android.webkit.WebView;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for MainActivity's Tailcat glue: the startup-URL guard, waiting for the
 * loopback listener, the validation-before-persist rule, the fall-back to plain HTTP
 * and the state JSON handed to the login page.
 *
 * <p>The Activity is allocated rather than built — {@code onCreate} does far more than
 * these paths need. {@code mBase}, {@code prefs}, {@code webView} and {@code mUiThread}
 * are filled in so the methods under test behave as they would in a running app.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class MainActivityTailcatBridgeTest {

    private static final String BLOB =
            "tcAwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dzj6vH4_wYNFBsiKTA3Pg";

    private MainActivity activity;
    private Object webAppInterface;

    @Before
    public void setUp() throws Exception {
        activity = allocateActivity();
        setStatic("instance", activity);

        Class<?> wai = Class.forName("com.clawbench.app.MainActivity$WebAppInterface");
        Constructor<?> ctor = wai.getDeclaredConstructor(MainActivity.class);
        ctor.setAccessible(true);
        webAppInterface = ctor.newInstance(activity);

        // A fresh manager per test: it is a process-wide singleton, so a previous
        // test's transport must not leak into this one.
        TailcatService.setManagerForTest(new TailcatManager(new NoopTransport()));
    }

    @After
    public void tearDown() throws Exception {
        setStatic("instance", null);
        TailcatService.setManagerForTest(null);
    }

    // =====================================================
    // tailcatStartupUrl — the "never load a non-loopback URL" guard
    // =====================================================

    @Test
    public void tailcatStartupUrl_onlyAppliesToTheTailcatTransport() {
        assertNull("a plain-HTTP install must not be hijacked by a stale loopback URL",
                MainActivity.tailcatStartupUrl(
                        TailcatService.TRANSPORT_HTTP, "http://127.0.0.1:54321"));
        assertNull(MainActivity.tailcatStartupUrl(null, "http://127.0.0.1:54321"));
        assertNull(MainActivity.tailcatStartupUrl("", "http://127.0.0.1:54321"));
    }

    @Test
    public void tailcatStartupUrl_rejectsAnythingThatIsNotLoopback() {
        // The whole point of the guard: a corrupted or hand-edited preference must
        // never point the WebView at a remote host.
        assertNull(MainActivity.tailcatStartupUrl(
                TailcatService.TRANSPORT_TAILCAT, "https://evil.example.com:20000"));
        assertNull(MainActivity.tailcatStartupUrl(
                TailcatService.TRANSPORT_TAILCAT, "http://192.168.1.10:20000"));
        assertNull(MainActivity.tailcatStartupUrl(
                TailcatService.TRANSPORT_TAILCAT, "http://localhost:54321"));
        // 127.0.0.1 with a look-alike host is still a different host.
        assertNull(MainActivity.tailcatStartupUrl(
                TailcatService.TRANSPORT_TAILCAT, "http://127.0.0.1.evil.com:54321"));
    }

    @Test
    public void tailcatStartupUrl_requiresARealPort() {
        assertNull(MainActivity.tailcatStartupUrl(
                TailcatService.TRANSPORT_TAILCAT, null));
        assertNull(MainActivity.tailcatStartupUrl(
                TailcatService.TRANSPORT_TAILCAT, ""));
        // No port would silently mean port 80.
        assertNull(MainActivity.tailcatStartupUrl(
                TailcatService.TRANSPORT_TAILCAT, "http://127.0.0.1"));
        assertNull(MainActivity.tailcatStartupUrl(
                TailcatService.TRANSPORT_TAILCAT, "http://127.0.0.1:"));
        assertNull(MainActivity.tailcatStartupUrl(
                TailcatService.TRANSPORT_TAILCAT, "http://127.0.0.1:0"));
    }

    @Test
    public void tailcatStartupUrl_acceptsThePersistedLoopbackUrl() {
        assertEquals("http://127.0.0.1:54321", MainActivity.tailcatStartupUrl(
                TailcatService.TRANSPORT_TAILCAT, "http://127.0.0.1:54321"));
    }

    // =====================================================
    // awaitTailcatLocalAddress
    // =====================================================

    @Test
    public void awaitTailcatLocalAddress_returnsTheAddressOnceRunning() {
        TailcatManager manager = new TailcatManager(new NoopTransport());
        assertTrue(manager.start(BLOB, 20000, 0));

        assertEquals("127.0.0.1:54321",
                MainActivity.awaitTailcatLocalAddress(manager, 1000));
    }

    @Test
    public void awaitTailcatLocalAddress_givesUpImmediatelyOnError() {
        TailcatManager manager = new TailcatManager(new NoopTransport());
        // A rejected address moves the manager straight to error.
        assertFalse(manager.start("not-a-blob", 20000, 0));

        long started = System.currentTimeMillis();
        assertNull(MainActivity.awaitTailcatLocalAddress(manager, 5000));
        assertTrue("an error must not be waited out",
                System.currentTimeMillis() - started < 2000);
    }

    @Test
    public void awaitTailcatLocalAddress_timesOutWhileStillStarting() {
        // Nothing has asked the transport to start, so the state stays disabled and
        // the wait has to end on its own rather than block forever.
        TailcatManager manager = new TailcatManager(new NoopTransport());
        assertEquals(TailcatManager.STATE_DISABLED, manager.getState());

        long started = System.currentTimeMillis();
        assertNull(MainActivity.awaitTailcatLocalAddress(manager, 150));
        assertTrue(System.currentTimeMillis() - started >= 100);
    }

    // =====================================================
    // startTailcat — validate before persisting
    // =====================================================

    @Test
    public void startTailcat_badAddress_reportsAndPersistsNothing() {
        activity.startTailcat("http://192.168.1.10:20000", 20000, "pw");

        assertEquals(MainActivityErrorCode.TRANSPORT, pendingErrorCode());
        assertEquals(activity.userLangString(R.string.tailcat_err_bad_address),
                pendingErrorMessage());

        SharedPreferences prefs = prefs();
        assertFalse("a rejected address must not become the saved configuration",
                prefs.contains(TailcatService.KEY_TAILCAT_ADDRESS));
        assertFalse(prefs.contains(TailcatService.KEY_SERVER_TRANSPORT));
        assertFalse(prefs.contains(TailcatService.KEY_TAILCAT_SERVER_PORT));
    }

    @Test
    public void startTailcat_emptyAddress_reportsTheEmptyAddressMessage() {
        activity.startTailcat("   ", 20000, "pw");
        assertEquals(activity.userLangString(R.string.tailcat_err_empty_address),
                pendingErrorMessage());
        assertEquals(MainActivityErrorCode.TRANSPORT, pendingErrorCode());
    }

    @Test
    public void startTailcat_badPort_reportsAndPersistsNothing() {
        // The address is fine here, so only the port can be the reason.
        activity.startTailcat(BLOB, 0, "pw");

        assertEquals(activity.userLangString(R.string.tailcat_err_bad_port),
                pendingErrorMessage());
        assertEquals(MainActivityErrorCode.TRANSPORT, pendingErrorCode());
        assertFalse(prefs().contains(TailcatService.KEY_TAILCAT_ADDRESS));
    }

    // =====================================================
    // reconnectTailcat
    // =====================================================

    @Test
    public void reconnectTailcat_withoutASavedAddress_reportsTheTailcatReconnectCode() {
        // Nothing was ever configured, so there is nothing to reconnect. The code has
        // to be the Tailcat-specific one so the login page puts the message on the
        // Tailcat card rather than on the plain-address form.
        activity.reconnectTailcat("pw");

        assertEquals(MainActivityErrorCode.TAILCAT_RECONNECT, pendingErrorCode());
        assertEquals(activity.userLangString(R.string.tailcat_err_not_running),
                pendingErrorMessage());
    }

    // =====================================================
    // stopTailcat
    // =====================================================

    @Test
    public void stopTailcat_dropsTheLoopbackUrlAndRestoresThePlainHttpUrl() {
        prefs().edit()
                .putString(TailcatService.KEY_SERVER_TRANSPORT, TailcatService.TRANSPORT_TAILCAT)
                .putString(TailcatService.KEY_TAILCAT_ADDRESS, BLOB)
                .putString(TailcatService.KEY_LOCAL_WEBVIEW_URL, "http://127.0.0.1:54321")
                .putInt(TailcatService.KEY_TAILCAT_LOCAL_PORT, 54321)
                .putInt(TailcatService.KEY_TAILCAT_SERVER_PORT, 20000)
                .putString(TailcatService.KEY_SERVER_INPUT_URL, "https://box.example.com:20000")
                .putString("server_url", "http://127.0.0.1:54321")
                .commit();

        activity.stopTailcat();

        SharedPreferences prefs = prefs();
        assertEquals(TailcatService.TRANSPORT_HTTP,
                prefs.getString(TailcatService.KEY_SERVER_TRANSPORT, null));
        assertFalse("a closed port must not stay loadable",
                prefs.contains(TailcatService.KEY_LOCAL_WEBVIEW_URL));
        assertEquals("the WebView goes back to the URL the user originally typed",
                "https://box.example.com:20000", prefs.getString("server_url", null));
        // The credential and the remote port stay so a retry needs no retyping.
        assertEquals(BLOB, prefs.getString(TailcatService.KEY_TAILCAT_ADDRESS, null));
        assertEquals(20000, prefs.getInt(TailcatService.KEY_TAILCAT_SERVER_PORT, 0));
    }

    @Test
    public void stopTailcat_withoutAPriorHttpUrl_leavesNoStaleUrlBehind() {
        prefs().edit()
                .putString(TailcatService.KEY_SERVER_TRANSPORT, TailcatService.TRANSPORT_TAILCAT)
                .putString(TailcatService.KEY_LOCAL_WEBVIEW_URL, "http://127.0.0.1:54321")
                .commit();

        activity.stopTailcat();

        assertFalse(prefs().contains("server_url"));
        assertFalse(prefs().contains(TailcatService.KEY_LOCAL_WEBVIEW_URL));
    }

    // =====================================================
    // removeTailcatServer
    // =====================================================

    @Test
    public void removeTailcatServer_wipesEveryTraceOfTheSavedAddress() {
        prefs().edit()
                .putString(TailcatService.KEY_SERVER_TRANSPORT, TailcatService.TRANSPORT_TAILCAT)
                .putString(TailcatService.KEY_TAILCAT_ADDRESS, BLOB)
                .putString(TailcatService.KEY_LOCAL_WEBVIEW_URL, "http://127.0.0.1:54321")
                .putInt(TailcatService.KEY_TAILCAT_LOCAL_PORT, 54321)
                .putInt(TailcatService.KEY_TAILCAT_SERVER_PORT, 20000)
                .putString(TailcatService.KEY_SERVER_INPUT_URL, "https://box.example.com:20000")
                .putString("server_url", "http://127.0.0.1:54321")
                .commit();

        activity.removeTailcatServer();

        SharedPreferences prefs = prefs();
        assertFalse("the bearer credential must not survive a removal",
                prefs.contains(TailcatService.KEY_TAILCAT_ADDRESS));
        assertFalse(prefs.contains(TailcatService.KEY_TAILCAT_SERVER_PORT));
        assertFalse(prefs.contains(TailcatService.KEY_TAILCAT_LOCAL_PORT));
        assertFalse(prefs.contains(TailcatService.KEY_LOCAL_WEBVIEW_URL));
        assertEquals("the app goes back to the plain-address transport",
                TailcatService.TRANSPORT_HTTP,
                prefs.getString(TailcatService.KEY_SERVER_TRANSPORT, null));
        assertEquals("the WebView falls back to the URL the user originally typed",
                "https://box.example.com:20000", prefs.getString("server_url", null));
        assertNull("the login page is reloaded with no pending error",
                pendingErrorMessage());
    }

    @Test
    public void removeTailcatServer_keepsThePlainHttpFallback() {
        // The fallback is not a credential, so removing the Tailcat server must not
        // take the plain-address configuration with it.
        prefs().edit()
                .putString(TailcatService.KEY_TAILCAT_ADDRESS, BLOB)
                .putString(TailcatService.KEY_SERVER_INPUT_URL, "https://box.example.com:20000")
                .commit();

        activity.removeTailcatServer();

        assertEquals("https://box.example.com:20000",
                prefs().getString(TailcatService.KEY_SERVER_INPUT_URL, null));
    }

    @Test
    public void removeTailcatServer_withoutASavedAddress_isHarmless() {
        activity.removeTailcatServer();

        assertEquals(TailcatService.TRANSPORT_HTTP,
                prefs().getString(TailcatService.KEY_SERVER_TRANSPORT, null));
        assertFalse("nothing to restore, so no stale URL may appear",
                prefs().contains("server_url"));
        assertFalse(prefs().contains(TailcatService.KEY_TAILCAT_ADDRESS));
    }

    // =====================================================
    // getTailcatState
    // =====================================================

    @Test
    public void getTailcatState_reportsTheTransportAndNeverTheAddress() throws Exception {
        prefs().edit()
                .putString(TailcatService.KEY_SERVER_TRANSPORT, TailcatService.TRANSPORT_TAILCAT)
                .putString(TailcatService.KEY_TAILCAT_ADDRESS, BLOB)
                .commit();

        String json = (String) webAppInterface.getClass()
                .getMethod("getTailcatState").invoke(webAppInterface);

        assertFalse("the ConnBlob is a bearer credential and must never be exposed",
                json.contains(BLOB));
        assertFalse(json.contains("tcAwoRGB"));

        JSONObject state = new JSONObject(json);
        assertEquals(TailcatService.TRANSPORT_TAILCAT, state.getString("transport"));
        assertEquals(TailcatManager.STATE_DISABLED, state.getString("state"));
        assertFalse(state.getBoolean("running"));
        assertEquals(TailcatManager.ERR_NONE, state.getString("errorType"));
        assertEquals(0, state.getInt("serverPort"));
        assertEquals(0, state.getInt("localPort"));
        assertTrue("the login page needs to know an address exists to offer a retry",
                state.getBoolean("hasAddress"));
    }

    @Test
    public void getTailcatState_withNoSavedAddress_saysSo() throws Exception {
        String json = (String) webAppInterface.getClass()
                .getMethod("getTailcatState").invoke(webAppInterface);

        JSONObject state = new JSONObject(json);
        assertEquals(TailcatService.TRANSPORT_HTTP, state.getString("transport"));
        assertFalse(state.getBoolean("hasAddress"));
    }

    // =====================================================
    // helpers
    // =====================================================

    /** Mirrors MainActivity's private ERROR_CODE_* so the tests read as intent. */
    private static final class MainActivityErrorCode {
        static final String TRANSPORT = "transport";
        static final String TAILCAT_RECONNECT = "tailcat_reconnect";
    }

    private SharedPreferences prefs() {
        return activity.getSharedPreferences(TailcatService.PREFS_NAME, Context.MODE_PRIVATE);
    }

    private String pendingErrorMessage() throws AssertionError {
        return (String) readField(activity, "pendingLoginErrorMessage");
    }

    private String pendingErrorCode() {
        return (String) readField(activity, "pendingLoginErrorCode");
    }

    private static Object readField(Object target, String name) {
        try {
            Field f = MainActivity.class.getDeclaredField(name);
            f.setAccessible(true);
            return f.get(target);
        } catch (Exception e) {
            throw new AssertionError("cannot read " + name, e);
        }
    }

    private static void setStatic(String name, Object value) throws Exception {
        Field f = MainActivity.class.getDeclaredField(name);
        f.setAccessible(true);
        f.set(null, value);
    }

    private static MainActivity allocateActivity() throws Exception {
        MainActivity allocated = allocate(MainActivity.class);

        // getSharedPreferences / getString / createConfigurationContext all resolve
        // through mBase, which an allocated ContextWrapper does not have.
        Context app = RuntimeEnvironment.getApplication();
        Field base = ContextWrapper.class.getDeclaredField("mBase");
        base.setAccessible(true);
        base.set(allocated, app);

        Field prefs = MainActivity.class.getDeclaredField("prefs");
        prefs.setAccessible(true);
        prefs.set(allocated, app.getSharedPreferences(
                TailcatService.PREFS_NAME, Context.MODE_PRIVATE));

        Field webView = MainActivity.class.getDeclaredField("webView");
        webView.setAccessible(true);
        webView.set(allocated, new WebView(app));

        // runOnUiThread posts to mHandler unless it is already on mUiThread; putting
        // the current thread there makes it run inline, as it would on the real one.
        Field uiThread = android.app.Activity.class.getDeclaredField("mUiThread");
        uiThread.setAccessible(true);
        uiThread.set(allocated, Thread.currentThread());

        return allocated;
    }

    @SuppressWarnings("unchecked")
    private static <T> T allocate(Class<T> type) throws Exception {
        Class<?> unsafeClass = Class.forName("sun.misc.Unsafe");
        Field theUnsafe = unsafeClass.getDeclaredField("theUnsafe");
        theUnsafe.setAccessible(true);
        Object unsafe = theUnsafe.get(null);
        java.lang.reflect.Method allocateInstance =
                unsafeClass.getMethod("allocateInstance", Class.class);
        return (T) allocateInstance.invoke(unsafe, type);
    }

    /** A transport that never touches libgojni.so, and always reports a loopback port. */
    private static final class NoopTransport implements TailcatManager.Transport {
        final List<String> events = new ArrayList<>();

        @Override
        public String start(String address, int serverPort, int localPort) {
            events.add("start");
            return "127.0.0.1:54321";
        }

        @Override
        public void stop() {
            events.add("stop");
        }
    }
}
