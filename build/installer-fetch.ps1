# SPDX-License-Identifier: GPL-3.0-or-later
# Downloads one file for the Windows installer (build/installer.nsh), which
# can't show sizes in MB and GB with its own download plug-in. It runs hidden;
# the installer reads how far it's got from a small status file and shows it.
#
# Everything comes in through the environment, so no path or link can upset
# the command line:
#   INKLEAF_URL     what to fetch
#   INKLEAF_DEST    where it goes (it's written to DEST.part until it's checked)
#   INKLEAF_SHA256  what it must hash to
#   INKLEAF_STATUS  the status file: three lines, the state (progress, ok,
#                   stopped or error), a sentence for the person, and a percent
#   INKLEAF_STOP    a file that, once it exists, means stop
#
# The SHA-256 is worked out while downloading, so there's no second pass over
# a file that can be several GB. A stopped or cut-off download keeps its .part
# file, and InkLeaf itself carries on from there (src/main/local-ai.ts).

$ErrorActionPreference = 'Stop'
$status = $env:INKLEAF_STATUS

function Say([string]$state, [string]$text, [int]$percent) {
  $tmp = "$status.tmp"
  # UTF-16 without a byte-order mark, which is what the installer reads (FileReadUTF16LE)
  [IO.File]::WriteAllText($tmp, "$state`r`n$text`r`n$percent`r`n", (New-Object Text.UnicodeEncoding ($false, $false)))
  Move-Item -LiteralPath $tmp -Destination $status -Force
}

function Size([double]$bytes) {
  if ($bytes -ge 1e9) { return '{0:0.0} GB' -f ($bytes / 1e9) }
  if ($bytes -ge 1e6) { return '{0:0} MB' -f ($bytes / 1e6) }
  return '{0:0} KB' -f ($bytes / 1e3)
}

function TimeLeft([double]$seconds) {
  if ($seconds -ge 3600) { return 'about {0:0.0} hours left' -f ($seconds / 3600) }
  if ($seconds -ge 90) { return 'about {0:0} minutes left' -f ($seconds / 60) }
  return 'about {0:0} seconds left' -f [Math]::Max(1, $seconds)
}

try {
  $url = $env:INKLEAF_URL
  $dest = $env:INKLEAF_DEST
  $want = $env:INKLEAF_SHA256.ToLowerInvariant()
  $stop = $env:INKLEAF_STOP
  $part = "$dest.part"

  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  Add-Type -AssemblyName System.Net.Http
  Say 'progress' 'Connecting...' 0

  # carry on from an earlier try: what's there already goes into the hash first
  $hash = [Security.Cryptography.SHA256]::Create()
  $buffer = New-Object byte[] (1MB)
  $have = [long]0
  if (Test-Path -LiteralPath $part) {
    $old = [IO.File]::OpenRead($part)
    while (($n = $old.Read($buffer, 0, $buffer.Length)) -gt 0) {
      [void]$hash.TransformBlock($buffer, 0, $n, $null, 0)
      $have += $n
    }
    $old.Close()
  }

  $client = New-Object Net.Http.HttpClient
  $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
  $request = New-Object Net.Http.HttpRequestMessage ([Net.Http.HttpMethod]::Get), $url
  $request.Headers.UserAgent.ParseAdd('InkLeafPDF-installer')
  if ($have -gt 0) { $request.Headers.Range = New-Object Net.Http.Headers.RangeHeaderValue ($have, $null) }
  $response = $client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()

  # a server that ignores the range sends the whole file again
  if ($have -gt 0 -and [int]$response.StatusCode -ne 206) {
    $hash.Dispose()
    $hash = [Security.Cryptography.SHA256]::Create()
    $have = [long]0
  }
  if (-not $response.IsSuccessStatusCode) { throw "the download server answered $([int]$response.StatusCode)" }

  $total = $have + [long]$response.Content.Headers.ContentLength
  $source = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
  $mode = if ($have -gt 0) { [IO.FileMode]::Append } else { [IO.FileMode]::Create }
  $out = New-Object IO.FileStream ($part, $mode, [IO.FileAccess]::Write)

  $clock = [Diagnostics.Stopwatch]::StartNew()
  $started = $have
  $shown = -1000
  while (($n = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
    $out.Write($buffer, 0, $n)
    [void]$hash.TransformBlock($buffer, 0, $n, $null, 0)
    $have += $n
    if ($clock.ElapsedMilliseconds - $shown -ge 400) {
      $shown = $clock.ElapsedMilliseconds
      if ($stop -and (Test-Path -LiteralPath $stop)) {
        $out.Close()
        Say 'stopped' '' 0
        exit
      }
      $speed = ($have - $started) / [Math]::Max(0.001, $clock.Elapsed.TotalSeconds)
      $percent = [int](100 * $have / [Math]::Max(1, $total))
      $left = TimeLeft (($total - $have) / [Math]::Max(1, $speed))
      Say 'progress' ('{0} of {1} ({2}%) at {3}/s, {4}' -f (Size $have), (Size $total), $percent, (Size $speed), $left) $percent
    }
  }
  $out.Close()
  [void]$hash.TransformFinalBlock($buffer, 0, 0)
  $got = -join ($hash.Hash | ForEach-Object { $_.ToString('x2') })
  if ($got -ne $want) {
    Remove-Item -LiteralPath $part -Force
    throw "the download didn't match what was expected"
  }
  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }
  Move-Item -LiteralPath $part -Destination $dest
  Say 'ok' '' 100
} catch {
  Say 'error' ($_.Exception.Message -replace '[\r\n]+', ' ') 0
}
