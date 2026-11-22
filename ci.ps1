param(
    [string]$Server,
    [string]$OpenSsl,
    [string]$FixtureHarness
)
$ErrorActionPreference = 'Stop'
$fixtureInputs = @($Server, $OpenSsl, $FixtureHarness) | Where-Object { $_ }
if (@($fixtureInputs).Count -notin 0,3) {
    throw 'Supply Server, OpenSsl, and FixtureHarness together.'
}
if ($FixtureHarness) {
    $Server = (Resolve-Path -LiteralPath $Server).Path
    $OpenSsl = (Resolve-Path -LiteralPath $OpenSsl).Path
    $FixtureHarness = (Resolve-Path -LiteralPath $FixtureHarness).Path
}
$npm = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { 'npm.cmd' } else { 'npm' }
$contractHash = 'E6500900A3FA34910781EA92D5E41FE8716511FAC6F6D6C689FF9CCE15D578AB'
Push-Location $PSScriptRoot
try {
    $contract = (Resolve-Path -LiteralPath 'contracts/sdp-contract-v1.zip').Path
    if ((Get-FileHash -LiteralPath $contract -Algorithm SHA256).Hash -ne $contractHash) {
        throw 'Pinned Server contract archive hash differs.'
    }
    $nodeMajor = & node -p "Number(process.versions.node.split('.')[0])"
    if ($LASTEXITCODE -or [int]$nodeMajor -lt 22) { throw 'Node 22 or later is required.' }

    $cachePath = 'out/npm-cache-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
    $cache = (New-Item -ItemType Directory -Path $cachePath).FullName
    & $npm --cache $cache --offline --update-notifier=false test
    if ($LASTEXITCODE) { exit $LASTEXITCODE }

    $packages = (New-Item -ItemType Directory -Path 'out/packages' -Force).FullName
    $json = & $npm --cache $cache --offline --update-notifier=false pack --ignore-scripts --json --pack-destination $packages
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    $pack = @($json -join [Environment]::NewLine | ConvertFrom-Json)[0]
    $files = @(
        'README.md', 'contracts/sdp-contract-v1.zip', 'package.json', 'src/errors.mjs',
        'src/index.mjs', 'src/native.mjs', 'src/provider.mjs', 'src/types.mjs', 'src/wire.mjs'
    )
    $sdkMetadata = Get-Content -Raw -LiteralPath 'package.json' | ConvertFrom-Json
    if ($pack.id -ne ($sdkMetadata.name + '@' + $sdkMetadata.version) -or
        @(Compare-Object $files @($pack.files.path)).Count -ne 0 -or $pack.entryCount -ne $files.Count) {
        throw 'npm tarball identity or contents differ from the verified release specification.'
    }
    $tarball = (Resolve-Path -LiteralPath (Join-Path $packages $pack.filename)).Path

    $consumerName = 'out/c' + [Guid]::NewGuid().ToString('N').Substring(0,8)
    $consumer = (New-Item -ItemType Directory -Path $consumerName).FullName
    Set-Content -Encoding Ascii -LiteralPath (Join-Path $consumer 'package.json') -Value '{"name":"sdp-installed-consumer","private":true,"type":"module"}'
    if ($FixtureHarness) {
        Copy-Item -LiteralPath 'tests/acceptance.mjs' -Destination $consumer
    }
    Push-Location $consumer
    try {
        & $npm --cache $cache --offline --update-notifier=false install --ignore-scripts --no-audit --no-fund --package-lock=false $tarball
        if ($LASTEXITCODE) { exit $LASTEXITCODE }
        $smoke = @'
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sep} from 'node:path';
import {connect, connectNative, NativeJson, NativeDecimal, contractPath} from 'stardataparadise';
const installed = process.cwd() + sep + 'node_modules' + sep;
if (typeof connect !== 'function' || typeof connectNative !== 'function' || !contractPath.startsWith(installed)) process.exit(1);
if (new NativeJson('{"id":9007199254740993}').text !== '{"id":9007199254740993}') process.exit(1);
if (new NativeDecimal('12345678901234567890.123456789').text !== '12345678901234567890.123456789') process.exit(1);
const digest = createHash('sha256').update(readFileSync(contractPath)).digest('hex');
if (digest !== process.argv[1].toLowerCase()) process.exit(1);
console.log('Installed package entry point and immutable wire archive verified');
'@
        & node --input-type=module --eval $smoke $contractHash
        if ($LASTEXITCODE) { exit $LASTEXITCODE }
    }
    finally {
        Pop-Location
    }
    if ($FixtureHarness) {
        $acceptance = Join-Path $consumer 'acceptance.mjs'
        & python -B $FixtureHarness --server $Server --openssl $OpenSsl --contract $contract --scratch out/integration --client-cwd $consumer --drop-op tx_commit --drop-read -- node $acceptance
        if ($LASTEXITCODE) { exit $LASTEXITCODE }
    }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $tarball).Hash
    Write-Output "$hash  $($pack.filename)"
    exit 0
}
finally {
    Pop-Location
}
