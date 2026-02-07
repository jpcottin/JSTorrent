import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

interface DaemonInfo {
  port: number;
  token: string;
  host: string;
}

function App() {
  const [daemonInfo, setDaemonInfo] = useState<DaemonInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function pollDaemon() {
      // Poll until daemon is ready (it starts async)
      for (let i = 0; i < 50; i++) {
        try {
          const info = await invoke<DaemonInfo>("get_daemon_info");
          if (!cancelled) {
            setDaemonInfo(info);
          }
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      if (!cancelled) {
        setError("io-daemon failed to start");
      }
    }

    pollDaemon();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>JSTorrent Desktop</h1>
      {error && <p style={{ color: "red" }}>{error}</p>}
      {daemonInfo ? (
        <p>
          io-daemon connected at {daemonInfo.host}:{daemonInfo.port}
        </p>
      ) : (
        <p>Starting io-daemon...</p>
      )}
    </div>
  );
}

export default App;
