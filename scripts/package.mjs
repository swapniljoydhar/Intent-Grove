/**
 * Packages the extension into dist/intent-grove.zip.
 *
 * Archiver selection is capability-probed, never assumed. Windows uses the
 * .NET ZIP API shipped with PowerShell rather than relying on the optional
 * Microsoft.PowerShell.Archive module. Other hosts prefer `zip`, then Python.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const dist = `${root}/dist`;
const archive = `${dist}/intent-grove.zip`;
const entries = ['manifest.json', 'background', 'content', 'dashboard', 'guide', 'icons', 'newtab', 'popup', 'settings', 'shared'];
const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`;

// Preference order. Both Unix candidates store paths relative to `root` and
// recurse into directories, so the produced archive is identical either way.
const ARCHIVERS = process.platform === 'win32'
  ? [{
      name: 'PowerShell .NET ZIP',
      file: 'powershell.exe',
      args: () => {
        const paths = entries.map(quotePowerShell).join(',');
        const script = [
          "$ErrorActionPreference='Stop'",
          'Add-Type -AssemblyName System.IO.Compression',
          'Add-Type -AssemblyName System.IO.Compression.FileSystem',
          `$root=${quotePowerShell(root)}`,
          `$archive=${quotePowerShell(archive)}`,
          `$entries=@(${paths})`,
          '$zip=[IO.Compression.ZipFile]::Open($archive,[IO.Compression.ZipArchiveMode]::Create)',
          'try { foreach($entry in $entries) { $source=Join-Path $root $entry; if(Test-Path -LiteralPath $source -PathType Leaf) { $items=@(Get-Item -LiteralPath $source) } else { $items=@(Get-ChildItem -LiteralPath $source -File -Recurse) }; foreach($item in $items) { $name=$item.FullName.Substring($root.Length+1).Replace("\\","/"); $null=[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$item.FullName,$name) } } } finally { $zip.Dispose() }'
        ].join('; ');
        return ['-NoProfile', '-NonInteractive', '-Command', script];
      }
    }]
  : [
      { name: 'zip', file: 'zip', args: () => ['-rq', archive, ...entries] },
      { name: 'python3 zipfile', file: 'python3', args: () => ['-m', 'zipfile', '-c', archive, ...entries] }
    ];

/** Runs the first archiver this host can actually spawn. */
function runArchiver() {
  const failures = [];
  for (const candidate of ARCHIVERS) {
    const result = spawnSync(candidate.file, candidate.args(), { cwd: root, stdio: 'inherit', shell: false });
    // A missing binary surfaces as result.error (ENOENT); that is the "platform
    // capability absent" signal, so fall through rather than assuming it exists.
    if (result.error) { failures.push(`${candidate.name}: ${result.error.code}`); continue; }
    if (result.status !== 0 || !existsSync(archive)) { failures.push(`${candidate.name}: exit ${result.status ?? 'unknown'}`); continue; }
    return candidate.name;
  }
  throw new Error(`Packaging failed - no usable archiver. Tried ${failures.join('; ')}. Install 'zip', or python3 with the zipfile module.`);
}

mkdirSync(dist, { recursive: true });
rmSync(archive, { force: true });

const used = runArchiver();
console.log(`Packaged ${archive} (via ${used})`);

