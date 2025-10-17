$path = 'c:\Users\m-pc\Desktop\project_fixed_\sync-hybrid.js'
$src = Get-Content -Raw $path
$len = $src.Length
function isIdent([char]$c){ return ($c -match '[A-Za-z0-9_$]') }
$issues = @()
for ($i = 0; $i -lt $len; $i++) {
  if ($i+3 -le $len -and $src.Substring($i,3) -eq 'try') {
    $before = if ($i -gt 0) { $src[$i-1] } else { '' }
    $after = if ($i+3 -lt $len) { $src[$i+3] } else { '' }
    if (-not (isIdent $before) -and -not (isIdent $after)) {
      $j = $i + 3
      while ($j -lt $len) {
        $ch = $src[$j]
        if ($ch -match '\s') { $j++; continue }
        if ($j+1 -lt $len -and $src.Substring($j,2) -eq '//') { $n = $src.IndexOf("`n", $j+2); if ($n -lt 0) { $j = $len; break } else { $j = $n+1; continue } }
        if ($j+1 -lt $len -and $src.Substring($j,2) -eq '/*') { $n = $src.IndexOf('*/', $j+2); if ($n -lt 0) { $j = $len; break } else { $j = $n+2; continue } }
        break
      }
      if ($j -ge $len) { $issues += @{pos=$i; reason='no { after try'}; continue }
      if ($src[$j] -ne '{') { $issues += @{pos=$i; reason='no { after try'; nextChar=$src[$j]}; continue }
      # find matching }
      $k = $j; $stack = 0
      while ($k -lt $len) {
        $ch = $src[$k]
        if ($k+1 -lt $len -and $src.Substring($k,2) -eq '//') { $n = $src.IndexOf("`n", $k+2); if ($n -lt 0) { $k = $len; break } else { $k = $n+1; continue } }
        if ($k+1 -lt $len -and $src.Substring($k,2) -eq '/*') { $n = $src.IndexOf('*/', $k+2); if ($n -lt 0) { $k = $len; break } else { $k = $n+2; continue } }
        if ($src[$k] -eq '"' -or $src[$k] -eq "'") { $quote = $src[$k]; $k++; while ($k -lt $len) { if ($src[$k] -eq '`\') { $k += 2; continue } if ($src[$k] -eq $quote) { break } $k++ }; $k++; continue }
        if ($src[$k] -eq '`') { $k++; while ($k -lt $len) { if ($src[$k] -eq '`\') { $k += 2; continue } if ($src[$k] -eq '`') { break } $k++ }; $k++; continue }
        if ($src[$k] -eq '{') { $stack++; $k++; continue }
        if ($src[$k] -eq '}') { $stack--; if ($stack -eq 0) { break } $k++; continue }
        $k++
      }
      if ($k -ge $len) { $issues += @{pos=$i; reason='no matching } for try block'}; continue
      $m = $k+1
      while ($m -lt $len) {
        $ch = $src[$m]
        if ($ch -match '\s') { $m++; continue }
        if ($m+1 -lt $len -and $src.Substring($m,2) -eq '//') { $n = $src.IndexOf("`n", $m+2); if ($n -lt 0) { $m = $len; break } else { $m = $n+1; continue } }
        if ($m+1 -lt $len -and $src.Substring($m,2) -eq '/*') { $n = $src.IndexOf('*/', $m+2); if ($n -lt 0) { $m = $len; break } else { $m = $n+2; continue } }
        break
      }
      if ($m -ge $len) { $issues += @{pos=$i; reason='block ended at EOF, no catch/finally'}; continue }
      $next = $src.Substring($m,10) -replace '[\s\{\(\);,].*$', ''
      if ($next -ne 'catch' -and $next -ne 'finally') {
        $before = $src.Substring(0,$i)
        $line = ($before -split "`n").Count
        $col = $i - ($before.LastIndexOf("`n")) -1
        $issues += @{pos=$i; line=$line; col=$col; reason='missing catch/finally after try'; next=$next; blockEnd=$k}
      }
    }
  }
}
if ($issues.Count -eq 0) { Write-Output 'No problematic try blocks found'; exit 0 }
Write-Output 'Found possible issues:'
foreach ($m in $issues) { Write-Output ("- at pos $($m.pos) (line $($m.line), col $($m.col)): $($m.reason) nextToken=$($m.next) blockEnd=$($m.blockEnd)") }
