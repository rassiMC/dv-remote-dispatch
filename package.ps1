param (
    [string]$Configuration = "Debug",
    [string]$DVPath
)

# build folder
$BuildDir = Join-Path $PSScriptRoot "build"

# Copy licence + manifest from repo root
foreach ($file in @("LICENSE", "info.json")) {
    $src = Join-Path $PSScriptRoot $file
    if (Test-Path $src) {
        Copy-Item -Force -Path $src -Destination $BuildDir
    } else {
        Write-Output "Expected file not found: $src"
        exit 1
    }
}

if ($Configuration -eq "Release") {
    $DistDir  = Join-Path $PSScriptRoot "dist"
    New-Item $DistDir -ItemType Directory -Force | Out-Null

    $ZipPath = Join-Path $DistDir "RemoteDispatch.zip"
    Compress-Archive -Update -CompressionLevel Fastest -Path (Join-Path $BuildDir "*") -DestinationPath $ZipPath

    Write-Output "Packaged: $ZipPath"
} else {
    $DeployDir = Join-Path $DVPath "Mods\RemoteDispatch"
    New-Item $DeployDir -ItemType Directory -Force | Out-Null
    Copy-Item -Force -Recurse -Path (Join-Path $BuildDir "*") -Destination $DeployDir

    Write-Output "Deployed to: $DeployDir"
}
