param([string]$Repository = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $Repository
function Git-Checked {
  & git @args
  if ($LASTEXITCODE -ne 0) { throw 'Git command failed. No reset, forced merge or push was attempted.' }
}
$branch = (& git branch --show-current)
if ($LASTEXITCODE -ne 0 -or $branch -notin @('main','fix/data-reliability')) { throw 'Expected main or fix/data-reliability; inspect the current checkout.' }
& git merge-base --is-ancestor main HEAD
if ($LASTEXITCODE -ne 0) { throw 'main has diverged. Resolve its changes before releasing; this script will not overwrite them.' }
& node scripts/check.js
if ($LASTEXITCODE -ne 0) { throw 'JavaScript syntax validation failed.' }
& node --test --test-concurrency=1 test/*.test.js
if ($LASTEXITCODE -ne 0) { throw 'Tests failed; nothing has been committed or deployed.' }
# Explicit source paths exclude credentials, runtime journals and generated backups.
Git-Checked add .dockerignore .gitignore .env.example Dockerfile README.md compose.yaml package.json public scripts src test docs
& git diff --cached --quiet
$stagedExit = $LASTEXITCODE
if ($stagedExit -eq 1) {
  Git-Checked commit -m 'Add session scheduling, ranked crypto, closing-news carry research and trade returns'
} elseif ($stagedExit -ne 0) { throw 'Cannot inspect staged changes.' }
if ($branch -ne 'main') {
  Git-Checked switch main
  Git-Checked merge --ff-only $branch
}
$mainCommit = (& git rev-parse HEAD)
if ($LASTEXITCODE -ne 0) { throw 'Cannot verify the main commit.' }
Write-Output "Committed release on local main: $mainCommit"
# Existing deployment workflow backs up the journal, retains a rollback image,
# preserves the $2,000 ceiling and verifies protection before resuming entries.
& (Join-Path $PSScriptRoot 'deploy-paper.ps1') -Repository $Repository
