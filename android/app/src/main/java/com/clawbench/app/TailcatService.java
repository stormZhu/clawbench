package com.clawbench.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Foreground service that owns the Tailcat transport for as long as the app needs it,
 * so the loopback listener behind the WebView survives the Activity being backgrounded.
 *
 * <p>Commands arrive as string actions on the service intent — the same shape
 * {@link BackgroundService} uses. All of them run on a single-thread executor, which is
 * what keeps a rapid START/STOP pair from interleaving inside {@link TailcatManager}.
 *
 * <p>The Tailcat address is a bearer credential, so it is only ever written to private
 * preferences, never to a log line.
 */
public class TailcatService extends Service {

    private static final String TAG = "ClawBench";

    public static final String ACTION_START = "START_TAILCAT";
    public static final String ACTION_STOP = "STOP_TAILCAT";
    public static final String ACTION_RECONNECT = "RECONNECT_TAILCAT";
    public static final String ACTION_ROTATE = "ROTATE_TAILCAT";
    /** Tears the transport down <em>and</em> drops the remembered address. */
    public static final String ACTION_FORGET = "FORGET_TAILCAT";

    public static final String EXTRA_ADDRESS = "address";
    public static final String EXTRA_SERVER_PORT = "server_port";
    public static final String EXTRA_LOCAL_PORT = "local_port";

    /**
     * Preferences shared with {@code MainActivity}. Declared once here so the two
     * sides cannot drift the way {@code PREFS_NAME}/{@code server_url} did.
     */
    public static final String PREFS_NAME = "clawbench_prefs";
    public static final String KEY_SERVER_TRANSPORT = "server_transport";
    public static final String KEY_SERVER_INPUT_URL = "server_input_url";
    public static final String KEY_TAILCAT_ADDRESS = "tailcat_address";
    public static final String KEY_LOCAL_WEBVIEW_URL = "local_webview_url";
    public static final String KEY_TAILCAT_LOCAL_PORT = "tailcat_local_port";
    /**
     * The remote ClawBench port to dial over the tailnet. Distinct from
     * {@link #KEY_TAILCAT_LOCAL_PORT}: a Tailcat address (ConnBlob) carries no port,
     * so without this a restarted process cannot rebuild the tunnel.
     */
    public static final String KEY_TAILCAT_SERVER_PORT = "tailcat_server_port";

    /** Values for {@link #KEY_SERVER_TRANSPORT}. */
    public static final String TRANSPORT_HTTP = "http";
    public static final String TRANSPORT_TAILCAT = "tailcat";

    static final String CHANNEL_ID = "clawbench_tailcat";
    /** 2 and 3 belong to BackgroundService, 100 to LiveUpdateManager. */
    static final int NOTIFICATION_ID = 4;

    /**
     * Connectivity callbacks that land this soon after a start are the registration
     * callback, not a real network change.
     */
    static final long NETWORK_SETTLE_MS = 2000L;

    private static volatile TailcatService instance;
    private static volatile boolean isRunning;
    private static volatile TailcatManager manager;

    private ExecutorService executor;
    private ConnectivityManager.NetworkCallback networkCallback;
    private volatile long startedAtMs;

    // =====================================================
    // Static entry points (callers never bind to the service)
    // =====================================================

    /** Brings the transport up for {@code address}; {@code serverPort} is the ClawBench port. */
    public static void start(Context context, String address, int serverPort) {
        send(context, ACTION_START, address, serverPort, 0);
    }

    /** Tears the transport down and stops the service. */
    public static void stop(Context context) {
        send(context, ACTION_STOP, null, 0, 0);
    }

    /** Rebuilds the transport from the last known address, reusing the loopback port. */
    public static void reconnect(Context context) {
        send(context, ACTION_RECONNECT, null, 0, 0);
    }

    /** Switches to a new address, releasing the previous transport first. */
    public static void rotate(Context context, String address, int serverPort) {
        send(context, ACTION_ROTATE, address, serverPort, 0);
    }

    /**
     * Tears the transport down and makes the service forget the address it was using,
     * so nothing in memory can rebuild the tunnel. Preference cleanup is left to the
     * caller ({@code MainActivity}), which also restores the plain-HTTP fallback.
     */
    public static void forget(Context context) {
        send(context, ACTION_FORGET, null, 0, 0);
    }

    private static void send(Context context, String action, String address,
                             int serverPort, int localPort) {
        Intent intent = new Intent(context, TailcatService.class);
        intent.setAction(action);
        if (address != null) {
            intent.putExtra(EXTRA_ADDRESS, address);
        }
        intent.putExtra(EXTRA_SERVER_PORT, serverPort);
        intent.putExtra(EXTRA_LOCAL_PORT, localPort);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception e) {
            // Android 12+ rejects a foreground-service start from the background
            // without an exemption.
            AppLog.e(TAG, "Tailcat: failed to start TailcatService for " + action
                    + ": " + e.getMessage(), e);
        }
    }

    static boolean isRunning() {
        return isRunning;
    }

    /** The service instance, or null when it is not running. */
    static TailcatService getInstance() {
        return instance;
    }

    /**
     * The process-wide manager. Created on first use so the state can be read before
     * anything has been started — the bridge should report "disabled" rather than
     * fail when the transport was never configured.
     */
    static TailcatManager manager() {
        TailcatManager m = manager;
        if (m == null) {
            synchronized (TailcatService.class) {
                m = manager;
                if (m == null) {
                    m = new TailcatManager();
                    manager = m;
                }
            }
        }
        return m;
    }

    /** Test seam: lets a test install a manager backed by a fake transport. */
    static void setManagerForTest(TailcatManager m) {
        manager = m;
    }

    // =====================================================
    // Service lifecycle
    // =====================================================

    @Override
    public void onCreate() {
        super.onCreate();
        isRunning = true;
        instance = this;
        executor = Executors.newSingleThreadExecutor();
        createNotificationChannel();
        startForegroundCompat(NOTIFICATION_ID, buildNotification(manager()));
        AppLog.logMemory(this, TAG, "TailcatService.onCreate");
        registerNetworkCallback();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundCompat(NOTIFICATION_ID, buildNotification(manager()));

        if (intent == null) {
            // Restarted by the system after a kill. Resuming needs the address from
            // preferences because the original intent is gone; without one the
            // transport simply stays down. The local port is deliberately not reused:
            // the WebView is not loaded yet, so the OS may pick a fresh one.
            final String address = restoredAddress(this);
            final int serverPort = restoredServerPort(this);
            if (!address.isEmpty()) {
                execute(() -> {
                    applyCommand(ACTION_START, address, serverPort, 0, manager());
                    afterCommand(ACTION_START, address);
                });
            }
            return START_STICKY;
        }

        final String action = intent.getAction();
        final String address = intent.getStringExtra(EXTRA_ADDRESS);
        final int serverPort = intent.getIntExtra(EXTRA_SERVER_PORT, 0);
        final int localPort = intent.getIntExtra(EXTRA_LOCAL_PORT, 0);

        execute(() -> {
            if (!applyCommand(action, address, serverPort, localPort, manager())) {
                AppLog.w(TAG, "Tailcat: ignoring unknown action " + action);
                return;
            }
            afterCommand(action, address);
        });
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        isRunning = false;
        instance = null;
        unregisterNetworkCallback();

        // Release the transport and drop the loopback URL together: once the
        // listener is gone the URL must not remain loadable.
        try {
            manager().stop();
        } catch (Exception e) {
            AppLog.w(TAG, "Tailcat: stop failed during destroy: " + e.getMessage());
        }
        prefs().edit().remove(KEY_LOCAL_WEBVIEW_URL).apply();

        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
        stopForeground(true);
        AppLog.i(TAG, "Tailcat: service destroyed");
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // =====================================================
    // Command handling
    // =====================================================

    /**
     * Applies one command to {@code m}. Split out of {@link #onStartCommand} so the
     * dispatch can be exercised without an attached Service.
     *
     * @return true when the action was recognised
     */
    static boolean applyCommand(String action, String address, int serverPort, int localPort,
                                TailcatManager m) {
        if (action == null) {
            return false;
        }
        switch (action) {
            case ACTION_START:
                m.start(address, serverPort, localPort);
                return true;
            case ACTION_ROTATE:
                // A rotate is a start with a fresh address: release the old transport
                // first so the two never contend for the same loopback port.
                m.stop();
                m.start(address, serverPort, localPort);
                return true;
            case ACTION_RECONNECT:
                m.reconnect();
                return true;
            case ACTION_STOP:
                m.stop();
                return true;
            case ACTION_FORGET:
                // Stop before forgetting: forget() only clears bookkeeping, so doing it
                // first would leave the listener running with no address to describe it.
                m.stop();
                m.forget();
                return true;
            default:
                return false;
        }
    }

    /** Post-command bookkeeping: preferences, mutual exclusion, notification. */
    private void afterCommand(String action, String address) {
        TailcatManager m = manager();
        if (m.isRunning()) {
            startedAtMs = System.currentTimeMillis();
            stopSshService();
        }
        persist(m, address);
        updateNotification();
        // Forget is a stop plus cleanup, so it ends the service the same way.
        if (ACTION_STOP.equals(action) || ACTION_FORGET.equals(action)) {
            stopSelf();
        }
    }

    /**
     * Only one transport may drive the WebView at a time, so bringing Tailcat up
     * takes the SSH tunnel down. No-op when BackgroundService is not running.
     */
    private void stopSshService() {
        try {
            BackgroundService.stop(this);
        } catch (Exception e) {
            AppLog.w(TAG, "Tailcat: could not stop the SSH service: " + e.getMessage());
        }
    }

    /**
     * Mirrors the transport state into preferences. The loopback URL is only written
     * while the transport is up, and removed the moment it is not — a stale URL would
     * otherwise send the WebView to a dead port.
     */
    private void persist(TailcatManager m, String address) {
        SharedPreferences.Editor e = prefs().edit();
        if (m.isRunning()) {
            String local = m.getLocalAddress();
            e.putString(KEY_SERVER_TRANSPORT, TRANSPORT_TAILCAT);
            if (address != null && !address.isEmpty()) {
                e.putString(KEY_TAILCAT_ADDRESS, address);
            }
            e.putString(KEY_LOCAL_WEBVIEW_URL, "http://" + local);
            e.putInt(KEY_TAILCAT_LOCAL_PORT, TailcatManager.portOf(local));
            // The remote port is not in the ConnBlob, so it has to be persisted
            // separately or a restart cannot rebuild the tunnel.
            e.putInt(KEY_TAILCAT_SERVER_PORT, m.getServerPort());
        } else {
            e.remove(KEY_LOCAL_WEBVIEW_URL);
        }
        e.apply();
    }

    private SharedPreferences prefs() {
        return prefs(this);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    /** The address to rebuild with after a process kill, or {@code ""} if never set. */
    static String restoredAddress(Context context) {
        return prefs(context).getString(KEY_TAILCAT_ADDRESS, "");
    }

    /**
     * The remote ClawBench port to rebuild with after a process kill, or 0 if never
     * set. Read from {@link #KEY_TAILCAT_SERVER_PORT}, never from the local port key.
     */
    static int restoredServerPort(Context context) {
        return prefs(context).getInt(KEY_TAILCAT_SERVER_PORT, 0);
    }

    private void execute(Runnable task) {
        ExecutorService ex = executor;
        if (ex == null || ex.isShutdown()) {
            AppLog.w(TAG, "Tailcat: command dropped, service is shutting down");
            return;
        }
        ex.execute(task);
    }

    // =====================================================
    // Connectivity
    // =====================================================

    private void registerNetworkCallback() {
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        if (cm == null) {
            return;
        }
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                onNetworkChanged();
            }
        };
        try {
            // API 24+; minSdk is 24.
            cm.registerDefaultNetworkCallback(networkCallback);
        } catch (Exception e) {
            AppLog.w(TAG, "Tailcat: network callback registration failed: " + e.getMessage());
            networkCallback = null;
        }
    }

    private void unregisterNetworkCallback() {
        ConnectivityManager.NetworkCallback cb = networkCallback;
        networkCallback = null;
        if (cb == null) {
            return;
        }
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        if (cm == null) {
            return;
        }
        try {
            cm.unregisterNetworkCallback(cb);
        } catch (Exception e) {
            AppLog.w(TAG, "Tailcat: network callback unregister failed: " + e.getMessage());
        }
    }

    private void onNetworkChanged() {
        long sinceStart = System.currentTimeMillis() - startedAtMs;
        TailcatManager m = manager();
        if (!shouldReconnectOnNetworkChange(sinceStart, m.getState(), m.getErrorType())) {
            return;
        }
        AppLog.i(TAG, "Tailcat: network changed, reconnecting");
        execute(() -> {
            TailcatManager current = manager();
            if (!shouldReconnectOnNetworkChange(
                    System.currentTimeMillis() - startedAtMs,
                    current.getState(),
                    current.getErrorType())) {
                return;
            }
            current.reconnect();
            persist(current, null);
            updateNotification();
        });
    }

    /**
     * Whether a connectivity callback should drive a reconnect.
     *
     * <p>A change only matters once the registration callback has settled, and only
     * when the transport is actually worth rebuilding — either it was up, or it failed
     * for a reason a new network could fix.
     *
     * <p>Only {@code start_failed} is retryable: it is what a failed dial surfaces as,
     * and a different network may well dial successfully. Every other error is either
     * about the address itself ({@code empty_address}, {@code bad_prefix},
     * {@code bad_encoding}, {@code bad_port}) or about a transport that was never
     * started ({@code not_running}) — reconnecting would replay the same permanent
     * failure, so these are deliberately an allow-list rather than "anything but
     * not_running".
     */
    static boolean shouldReconnectOnNetworkChange(long msSinceStart, String state,
                                                  String errorType) {
        if (msSinceStart < NETWORK_SETTLE_MS) {
            return false;
        }
        if (TailcatManager.STATE_RUNNING.equals(state)) {
            return true;
        }
        if (TailcatManager.STATE_ERROR.equals(state)) {
            return TailcatManager.ERR_START_FAILED.equals(errorType);
        }
        return false;
    }

    // =====================================================
    // Notification
    // =====================================================

    /** Maps transport state to the notification status line. */
    static int statusTextRes(String state) {
        if (TailcatManager.STATE_RUNNING.equals(state)) {
            return R.string.notif_tailcat_connected;
        }
        if (TailcatManager.STATE_STARTING.equals(state)) {
            return R.string.notif_tailcat_connecting;
        }
        if (TailcatManager.STATE_ERROR.equals(state)) {
            return R.string.notif_tailcat_error;
        }
        return R.string.notif_tailcat_stopped;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notif_channel_tailcat),
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.notif_channel_tailcat_desc));
        nm.createNotificationChannel(channel);
    }

    Notification buildNotification(TailcatManager m) {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this, 0, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(getString(statusTextRes(m.getState())))
                .setSmallIcon(R.drawable.ic_notification)
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .build();
    }

    private void updateNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) {
            return;
        }
        nm.notify(NOTIFICATION_ID, buildNotification(manager()));
    }

    /**
     * Declares both dataSync and remoteMessaging, matching BackgroundService: Android 15
     * caps a dataSync-only foreground service at six hours a day, and a transport that is
     * meant to stay up would be cut off.
     */
    private void startForegroundCompat(int id, Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(id, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                            | ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        } else {
            startForeground(id, notification);
        }
    }
}
