param([string]$Repository = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $Repository
$releaseVersion = (Get-Content -LiteralPath (Join-Path $Repository 'package.json') -Raw | ConvertFrom-Json).version
function Docker-Checked {
  & docker @args
  if ($LASTEXITCODE -ne 0) { throw 'Docker command failed. Deployment stopped; inspect the engine before resuming entries.' }
}
Docker-Checked info --format '{{.ServerVersion}}'
$dashboardToken = (& node --input-type=module -e "import{readFileSync}from'node:fs';import{parseEnv}from'node:util';process.stdout.write(parseEnv(readFileSync('.env','utf8')).DASHBOARD_TOKEN??'')")
if ($LASTEXITCODE -ne 0 -or $dashboardToken.Length -lt 32) { throw 'Cannot read the local dashboard token.' }
$headers = @{ Authorization = "Bearer $dashboardToken" }
$base = 'http://127.0.0.1:8080'
$before = Invoke-RestMethod "$base/api/status" -Headers $headers -TimeoutSec 10
if ($before.mode -ne 'paper' -or $before.limits.dailyLoss -ne 2000) { throw 'Expected the paper engine with its approved $2,000 limit. Review the current account/settings before deploying.' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $Repository 'backups'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$container = (& docker compose ps -q engine)
if ($LASTEXITCODE -ne 0 -or !$container) { throw 'The running engine container could not be identified.' }
$oldImage = (& docker inspect --format '{{.Image}}' $container)
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the previous image.' }
Docker-Checked tag $oldImage "signal-foundry:rollback-$stamp"
$revision = (& git rev-parse HEAD)
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify Git revision.' }
$dirty = [bool](& git status --porcelain)
# The build runs syntax checks and tests while the current engine still manages exits.
Docker-Checked compose build --build-arg "VCS_REF=$revision" --build-arg "SOURCE_DIRTY=$($dirty.ToString().ToLowerInvariant())" engine
Invoke-RestMethod "$base/api/control" -Method Post -Headers $headers -ContentType 'application/json' -Body '{"action":"pause"}' -TimeoutSec 10 | Out-Null
# A consistent online SQLite backup; neither the volume nor the journal is removed.
$backupName = "paper-pre-v$releaseVersion-$stamp.sqlite"
$backupCode = "import{DatabaseSync,backup}from'node:sqlite';import{mkdirSync}from'node:fs';mkdirSync('/app/data/backups',{recursive:true});const db=new DatabaseSync('/app/data/paper.sqlite',{readOnly:true});await backup(db,'/app/data/backups/$backupName');db.close();"
Docker-Checked compose exec -T engine node --input-type=module -e $backupCode
Docker-Checked compose cp "engine:/app/data/backups/$backupName" (Join-Path $backupDir $backupName)
& node --input-type=module -e "import{inspectBackup}from'./src/recovery.js';console.log(JSON.stringify(inspectBackup(process.argv[1])))" (Join-Path $backupDir $backupName)
if ($LASTEXITCODE -ne 0) { throw 'Backup integrity verification failed. Entries remain paused.' }
Docker-Checked compose up -d --no-deps engine
$after = $null
for ($attempt=0; $attempt -lt 60; $attempt++) {
  try { $after=Invoke-RestMethod "$base/api/status" -Headers $headers -TimeoutSec 5; if($after.version -eq $releaseVersion -and $after.protection.healthy){break} } catch {}
  Start-Sleep -Seconds 2
}
if (!$after -or $after.version -ne $releaseVersion -or $after.limits.dailyLoss -ne 2000 -or !$after.protection.healthy -or !$after.release.manifestVerified) { throw 'Post-deploy checks failed. Entries remain paused; use the retained backup/image and inspect protection before recovery.' }
if (!$before.paused -and $after.ready) {
  Invoke-RestMethod "$base/api/control" -Method Post -Headers $headers -ContentType 'application/json' -Body '{"action":"resume"}' -TimeoutSec 10 | Out-Null
}
[pscustomobject]@{version=$after.version;sourceSha256=$after.release.sourceSha256;dailyLoss=$after.limits.dailyLoss;backup=(Join-Path $backupDir $backupName);rollbackImage="signal-foundry:rollback-$stamp";resumed=(!$before.paused -and $after.ready)} | ConvertTo-Json
