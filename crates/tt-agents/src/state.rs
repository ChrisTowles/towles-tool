//! An agent's own folder: its working directory, the only place it can write unless
//! granted `dirs`, and where `MEMORY.md` lives.

use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tt_config::AgentDef;

pub fn state_dir(agents_dir: &Path, name: &str) -> PathBuf {
    agents_dir.join(name)
}

/// Create the folder, `notes/` and a starter `MEMORY.md`; never overwrites what the
/// agent already wrote.
pub fn seed_state_dir(dir: &Path, agent: &AgentDef) -> io::Result<()> {
    std::fs::create_dir_all(dir.join("notes"))?;
    let memory = dir.join("MEMORY.md");
    if !memory.exists() {
        let seed = format!(
            "# {}\n\n{}\n\n## Key Knowledge\n\n## Active Context\n",
            agent.name, agent.description
        );
        std::fs::write(memory, seed)?;
    }
    Ok(())
}

/// Missing reads as empty: a deleted MEMORY.md is an agent with nothing remembered.
pub fn read_memory(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("MEMORY.md")).unwrap_or_default()
}

pub fn memory_hash(memory: &str) -> String {
    Sha256::digest(memory.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeding_creates_memory_once_and_keeps_edits() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = state_dir(tmp.path(), "atlas");
        let agent =
            AgentDef { name: "atlas".into(), description: "Helper".into(), ..Default::default() };
        seed_state_dir(&dir, &agent).unwrap();
        assert!(dir.join("notes").is_dir());
        assert!(read_memory(&dir).starts_with("# atlas\n\nHelper"));
        std::fs::write(dir.join("MEMORY.md"), "mine").unwrap();
        seed_state_dir(&dir, &agent).unwrap();
        assert_eq!(read_memory(&dir), "mine");
    }

    #[test]
    fn hash_tracks_content() {
        assert_eq!(memory_hash("a"), memory_hash("a"));
        assert_ne!(memory_hash("a"), memory_hash("b"));
        assert_eq!(read_memory(Path::new("/nonexistent/x")), "");
    }
}
