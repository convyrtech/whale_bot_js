const fs = require('fs');
const path = require('path');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const archiveDir = path.join(projectRoot, 'archive', `backup_${timestamp}`);
  await fs.promises.mkdir(archiveDir, { recursive: true });
  const entries = await fs.promises.readdir(projectRoot, { withFileTypes: true });
  const targets = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => {
      const n = name.toLowerCase();
      return n.endsWith('.db') || n.endsWith('.db-shm') || n.endsWith('.db-wal') || n.endsWith('.sqlite');
    });
  const moved = [];
  for (const name of targets) {
    const src = path.join(projectRoot, name);
    const dest = path.join(archiveDir, name);
    try {
      await fs.promises.rename(src, dest);
      moved.push(name);
    } catch (err) {
    }
  }
  console.log(`Archive folder: ${path.relative(projectRoot, archiveDir)}`);
  if (moved.length === 0) {
    console.log('No database files found');
  } else {
    console.log('Moved files:');
    for (const m of moved) {
      console.log(`- ${m}`);
    }
  }
}

main().catch((e) => {
  console.error('Archive failed:', e.message || String(e));
  process.exit(1);
});

