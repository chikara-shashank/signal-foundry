param([string]$Destination = "signal-foundry-source.zip")
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$archiveTarget = [IO.Path]::GetFullPath((Join-Path $projectRoot $Destination))
if (-not $archiveTarget.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive must be inside this project directory.' }
Add-Type -AssemblyName System.IO.Compression
$stream = [IO.File]::Open($archiveTarget, [IO.FileMode]::CreateNew)
try {
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
  try {
    $included = @('src','public','scripts','test','docs','deploy','fixtures','.github','package.json','Dockerfile','compose.yaml','.env.example','.gitignore','.dockerignore','README.md')
    foreach ($item in $included) {
      $entryPath = Join-Path $projectRoot $item
      if (-not (Test-Path -LiteralPath $entryPath)) { continue }
      $sourceItem = Get-Item -LiteralPath $entryPath
      $sourceFiles = if ($sourceItem.PSIsContainer) { Get-ChildItem -LiteralPath $entryPath -Recurse -File } else { @($sourceItem) }
      foreach ($sourceFile in $sourceFiles) {
        if ($sourceFile.Name -match '\.tfstate|\.tfvars$|^\.env$') { continue }
        $relativeName = $sourceFile.FullName.Substring($projectRoot.Length + 1).Replace('\','/')
        $entry = $archive.CreateEntry($relativeName)
        $inputStream = $sourceFile.OpenRead()
        $outputStream = $entry.Open()
        try { $inputStream.CopyTo($outputStream) } finally { $inputStream.Dispose(); $outputStream.Dispose() }
      }
    }
  } finally { $archive.Dispose() }
} finally { $stream.Dispose() }
Write-Output "Created source archive without .env, runtime state, or cloud state: $archiveTarget"
