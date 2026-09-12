# Minimal static file server, so the ES modules load (browsers block module
# imports from file://). No installs required.
#
#   powershell -ExecutionPolicy Bypass -File serve.ps1
#
# then open http://localhost:8080/verify.html or http://localhost:8080/
# Ctrl+C to stop.

param([int]$Port = 8080)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$prefix = "http://localhost:$Port/"

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.json' = 'application/json'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.webp' = 'image/webp'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try {
  $listener.Start()
} catch {
  Write-Host "Could not bind $prefix - is the port already in use?" -ForegroundColor Red
  exit 1
}

Write-Host "Serving $root" -ForegroundColor Green
Write-Host "  $prefix" -ForegroundColor Green
Write-Host "  ${prefix}verify.html" -ForegroundColor Green
Write-Host "Ctrl+C to stop."

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $req = $context.Request
    $res = $context.Response
    try {
      $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
      if ([string]::IsNullOrWhiteSpace($rel)) { $rel = 'index.html' }
      $full = Join-Path $root $rel
      $resolved = [System.IO.Path]::GetFullPath($full)

      # Refuse anything outside the served directory. THE TRAILING SEPARATOR IS
      # THE GUARD: without it "C:\...\plotterApp" is a prefix of
      # "C:\...\plotterApp2\secrets", so a sibling directory passed the check.
      $rootFull = [System.IO.Path]::GetFullPath($root).TrimEnd([System.IO.Path]::DirectorySeparatorChar) +
                  [System.IO.Path]::DirectorySeparatorChar
      if (-not $resolved.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        $res.StatusCode = 403
      } elseif (Test-Path -LiteralPath $resolved -PathType Leaf) {
        $ext = [System.IO.Path]::GetExtension($resolved).ToLowerInvariant()
        $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
        $res.Headers.Add('Cache-Control', 'no-store')
        $bytes = [System.IO.File]::ReadAllBytes($resolved)
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $res.StatusCode = 404
        # The body echoes the requested path, so it must be typed as plain text:
        # untyped, a browser is free to sniff it, and the one thing it must never
        # do is treat a path someone chose as markup.
        $res.ContentType = 'text/plain; charset=utf-8'
        $msg = [System.Text.Encoding]::UTF8.GetBytes("404 $rel")
        $res.OutputStream.Write($msg, 0, $msg.Length)
      }
      Write-Host ("{0} {1}" -f $res.StatusCode, $rel)
    } catch {
      Write-Host "error: $_" -ForegroundColor Yellow
    } finally {
      $res.OutputStream.Close()
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
