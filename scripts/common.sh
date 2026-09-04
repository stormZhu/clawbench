#!/usr/bin/env bash
#
# ClawBench 共享 Shell 工具函数
# 所有脚本通过 source 此文件来复用公共逻辑
#

# show_auto_password prints the auto-generated password from the given file,
# if it exists.
show_auto_password() {
    local auto_pw_file="$1"
    if [[ -f "$auto_pw_file" ]]; then
        local pw
        pw=$(cat "$auto_pw_file")
        echo "  Password: $pw (auto-generated, saved in $auto_pw_file)"
    fi
}

# check_binary ensures the Go binary exists, building it if necessary.
# Arguments:
#   $1 - BIN       path to the binary
#   $2 - CONFIG    path to the config file (optional, for future use)
#   $3 - BUILD_CMD command to build the binary (optional, defaults to go build)
check_binary() {
    local bin="$1"
    local config="${2:-}"
    local build_cmd="${3:-go build -o $bin ./cmd/server}"

    if [[ ! -f "$bin" ]]; then
        echo "Binary not found, building..."
        if command -v go >/dev/null 2>&1; then
            eval "$build_cmd"
        else
            echo "Error: Go not found and binary missing." >&2
            exit 1
        fi
    fi
}

# _stop_servers stops processes tracked by the given PID file and/or by port.
# Arguments:
#   $1 - PID_FILE  path to the PID file (may be empty)
#   $2 - PORT      port to kill orphaned processes (may be empty)
#   $3 - NAME      display name for the service (optional, default "server")
_stop_servers() {
    local pid_file="$1"
    local port="$2"
    local name="${3:-server}"

    # Stop by PID file first
    if [[ -n "$pid_file" && -f "$pid_file" ]]; then
        local pid
        pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
            echo "Stopping $name (PID $pid)..."
            kill "$pid"
            sleep 5
            # Force kill if still alive
            if kill -0 "$pid" 2>/dev/null; then
                kill -9 "$pid" 2>/dev/null
                sleep 1
            fi
        fi
        rm -f "$pid_file"
    fi

    # Fallback: kill by port (use ss/netstat — never block like lsof can)
    if [[ -n "$port" ]]; then
        local pids=""
        if command -v ss >/dev/null 2>&1; then
            pids=$(ss -tlnp 2>/dev/null | grep ":$port" | grep -oP 'pid=\K[0-9]+' | sort -u | tr '\n' ' ')
        elif command -v netstat >/dev/null 2>&1; then
            pids=$(netstat -tlnp 2>/dev/null | grep ":$port" | grep -oP '\s[0-9]+/' | grep -oP '[0-9]+' | sort -u | tr '\n' ' ')
        fi
        if [[ -n "$pids" ]]; then
            echo "Killing orphan process on port $port (PIDs: $pids)..."
            echo "$pids" | xargs kill 2>/dev/null || true
            sleep 5
            # Force kill if still alive
            if command -v ss >/dev/null 2>&1; then
                local remaining
                remaining=$(ss -tlnp 2>/dev/null | grep ":$port" | grep -oP 'pid=\K[0-9]+' | sort -u | tr '\n' ' ')
                if [[ -n "$remaining" ]]; then
                    echo "$remaining" | xargs kill -9 2>/dev/null || true
                    sleep 1
                fi
            fi
        fi

        # Wait for port to be fully released
        local waited=0
        while [[ $waited -lt 5 ]]; do
            local bound=""
            if command -v ss >/dev/null 2>&1; then
                bound=$(ss -tlnp 2>/dev/null | grep ":$port") || true
            fi
            if [[ -z "$bound" ]]; then
                break
            fi
            sleep 0.5
            waited=$((waited + 1))
        done
    fi
}

# detect_java_home locates a valid Java 17+ JDK across macOS, Linux, and custom environments.
# Returns the JAVA_HOME path on stdout and exit code 0 if found, or exit code 1 if not found.
detect_java_home() {
    # 1. Use existing JAVA_HOME if valid
    if [[ -n "${JAVA_HOME:-}" && -d "$JAVA_HOME" && -x "$JAVA_HOME/bin/java" ]]; then
        echo "$JAVA_HOME"
        return 0
    fi

    # 2. macOS: try /usr/libexec/java_home, then Homebrew / Android Studio JBR
    if [[ "$(uname -s)" == "Darwin" ]]; then
        local jh
        jh=$(/usr/libexec/java_home -v 17 2>/dev/null || /usr/libexec/java_home 2>/dev/null || true)
        if [[ -n "$jh" && -d "$jh" && -x "$jh/bin/java" ]]; then
            echo "$jh"
            return 0
        fi
        for candidate in \
            "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home" \
            "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home" \
            "/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home" \
            "/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home" \
            "/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
            "/Applications/Android Studio.app/Contents/jre/Contents/Home"; do
            if [[ -d "$candidate" && -x "$candidate/bin/java" ]]; then
                echo "$candidate"
                return 0
            fi
        done
    fi

    # 3. Linux: common OpenJDK 17 locations
    for candidate in \
        "/usr/lib/jvm/java-17-openjdk-amd64" \
        "/usr/lib/jvm/java-17-openjdk-arm64" \
        "/usr/lib/jvm/java-17-openjdk" \
        "/usr/lib/jvm/default-java"; do
        if [[ -d "$candidate" && -x "$candidate/bin/java" ]]; then
            echo "$candidate"
            return 0
        fi
    done

    # 4. Fallback: resolve from `java` executable on PATH
    if command -v java >/dev/null 2>&1; then
        local java_bin
        java_bin=$(command -v java)
        local resolved
        resolved=$(readlink -f "$java_bin" 2>/dev/null || realpath "$java_bin" 2>/dev/null || true)
        if [[ -n "$resolved" ]]; then
            local bin_dir home_dir
            bin_dir=$(dirname "$resolved")
            home_dir=$(dirname "$bin_dir")
            if [[ -d "$home_dir" && -x "$home_dir/bin/java" ]]; then
                echo "$home_dir"
                return 0
            fi
        fi
    fi

    return 1
}
