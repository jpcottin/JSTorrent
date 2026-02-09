use anyhow::Result;
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::Path;

pub struct KvStore {
    conn: Connection,
}

impl KvStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        // Allow up to 5s wait when another process holds the database lock.
        // The Tauri app's sidecar and Chrome's native messaging host both open
        // this database; without a timeout, the second process gets SQLITE_BUSY
        // immediately and crashes (especially on Windows where locking is stricter).
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )?;
        Ok(Self { conn })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )?;
        Ok(Self { conn })
    }

    pub fn get(&self, key: &str) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare("SELECT value FROM kv WHERE key = ?1")?;
        let mut rows = stmt.query(rusqlite::params![key])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    pub fn get_multi(&self, keys: &[String]) -> Result<HashMap<String, String>> {
        if keys.is_empty() {
            return Ok(HashMap::new());
        }
        let placeholders: Vec<String> = (1..=keys.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "SELECT key, value FROM kv WHERE key IN ({})",
            placeholders.join(",")
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::types::ToSql> = keys
            .iter()
            .map(|k| k as &dyn rusqlite::types::ToSql)
            .collect();
        let mut rows = stmt.query(params.as_slice())?;
        let mut result = HashMap::new();
        while let Some(row) = rows.next()? {
            let k: String = row.get(0)?;
            let v: String = row.get(1)?;
            result.insert(k, v);
        }
        Ok(result)
    }

    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO kv (key, value) VALUES (?1, ?2)",
            rusqlite::params![key, value],
        )?;
        Ok(())
    }

    pub fn delete(&self, key: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM kv WHERE key = ?1", rusqlite::params![key])?;
        Ok(())
    }

    pub fn keys(&self, prefix: Option<&str>) -> Result<Vec<String>> {
        if let Some(p) = prefix {
            let mut stmt = self
                .conn
                .prepare("SELECT key FROM kv WHERE key LIKE ?1 ORDER BY key")?;
            let pattern = format!("{p}%");
            let mut rows = stmt.query(rusqlite::params![pattern])?;
            let mut result = Vec::new();
            while let Some(row) = rows.next()? {
                result.push(row.get(0)?);
            }
            Ok(result)
        } else {
            let mut stmt = self.conn.prepare("SELECT key FROM kv ORDER BY key")?;
            let mut rows = stmt.query([])?;
            let mut result = Vec::new();
            while let Some(row) = rows.next()? {
                result.push(row.get(0)?);
            }
            Ok(result)
        }
    }

    pub fn clear(&self, prefix: Option<&str>) -> Result<()> {
        if let Some(p) = prefix {
            let pattern = format!("{p}%");
            self.conn.execute(
                "DELETE FROM kv WHERE key LIKE ?1",
                rusqlite::params![pattern],
            )?;
        } else {
            self.conn.execute("DELETE FROM kv", [])?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_get_set() {
        let store = KvStore::open_in_memory().unwrap();
        assert_eq!(store.get("foo").unwrap(), None);
        store.set("foo", "bar").unwrap();
        assert_eq!(store.get("foo").unwrap(), Some("bar".to_string()));
    }

    #[test]
    fn test_overwrite() {
        let store = KvStore::open_in_memory().unwrap();
        store.set("key", "val1").unwrap();
        store.set("key", "val2").unwrap();
        assert_eq!(store.get("key").unwrap(), Some("val2".to_string()));
    }

    #[test]
    fn test_delete() {
        let store = KvStore::open_in_memory().unwrap();
        store.set("key", "val").unwrap();
        store.delete("key").unwrap();
        assert_eq!(store.get("key").unwrap(), None);
    }

    #[test]
    fn test_delete_nonexistent() {
        let store = KvStore::open_in_memory().unwrap();
        store.delete("nope").unwrap(); // should not error
    }

    #[test]
    fn test_keys_with_prefix() {
        let store = KvStore::open_in_memory().unwrap();
        store.set("session:a", "1").unwrap();
        store.set("session:b", "2").unwrap();
        store.set("config:x", "3").unwrap();

        let session_keys = store.keys(Some("session:")).unwrap();
        assert_eq!(session_keys, vec!["session:a", "session:b"]);

        let config_keys = store.keys(Some("config:")).unwrap();
        assert_eq!(config_keys, vec!["config:x"]);

        let all_keys = store.keys(None).unwrap();
        assert_eq!(all_keys, vec!["config:x", "session:a", "session:b"]);
    }

    #[test]
    fn test_clear_with_prefix() {
        let store = KvStore::open_in_memory().unwrap();
        store.set("session:a", "1").unwrap();
        store.set("session:b", "2").unwrap();
        store.set("config:x", "3").unwrap();

        store.clear(Some("session:")).unwrap();
        assert_eq!(store.get("session:a").unwrap(), None);
        assert_eq!(store.get("session:b").unwrap(), None);
        assert_eq!(store.get("config:x").unwrap(), Some("3".to_string()));
    }

    #[test]
    fn test_clear_all() {
        let store = KvStore::open_in_memory().unwrap();
        store.set("a", "1").unwrap();
        store.set("b", "2").unwrap();
        store.clear(None).unwrap();
        assert_eq!(store.keys(None).unwrap().len(), 0);
    }

    #[test]
    fn test_get_multi() {
        let store = KvStore::open_in_memory().unwrap();
        store.set("a", "1").unwrap();
        store.set("b", "2").unwrap();
        store.set("c", "3").unwrap();

        let result = store
            .get_multi(&["a".into(), "c".into(), "missing".into()])
            .unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result["a"], "1");
        assert_eq!(result["c"], "3");
    }

    #[test]
    fn test_get_multi_empty() {
        let store = KvStore::open_in_memory().unwrap();
        let result = store.get_multi(&[]).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn test_json_values() {
        let store = KvStore::open_in_memory().unwrap();
        let json = r#"{"torrents":[{"infoHash":"abc","source":"magnet"}]}"#;
        store.set("session:torrents", json).unwrap();
        assert_eq!(
            store.get("session:torrents").unwrap(),
            Some(json.to_string())
        );
    }
}
