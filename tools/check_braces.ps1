$path = 'c:\Users\m-pc\Desktop\project_fixed_\sync-hybrid.js'
$text = Get-Content -Raw $path
$stack = @()
$line = 1
$col = 0
for ($i = 0; $i -lt $text.Length; $i++) {
    $ch = $text[$i]
    if ($ch -eq "`n") { $line++; $col = 0; continue }
    $col++
    # skip strings
    if ($ch -eq '"' -or $ch -eq "'") {
        $quote = $ch
        $i++
        while ($i -lt $text.Length) {
            if ($text[$i] -eq '`\') { $i += 2; continue }
            if ($text[$i] -eq $quote) { break }
            if ($text[$i] -eq "`n") { $line++; $col = 0 }
            $i++
        }
        continue
    }
    if ($ch -eq '`') {
        $i++
        while ($i -lt $text.Length) {
            if ($text[$i] -eq '`\') { $i += 2; continue }
            if ($text[$i] -eq '`') { break }
            if ($text[$i] -eq "`n") { $line++; $col = 0 }
            $i++
        }
        continue
    }
    # skip comments
    if ($ch -eq '/' -and $i+1 -lt $text.Length -and $text[$i+1] -eq '/') {
        $i = $text.IndexOf("`n", $i+2)
        if ($i -lt 0) { break }
        $line++
        $col = 0
        continue
    }
    if ($ch -eq '/' -and $i+1 -lt $text.Length -and $text[$i+1] -eq '*') {
        $i = $text.IndexOf('*/', $i+2)
        if ($i -lt 0) { Write-Output "Unterminated comment at line $line col $col"; break }
        # move to end of comment
        $segment = $text.Substring(0,$i)
        $line = ($segment -split "`n").Count
        $col = $i - $segment.LastIndexOf("`n") - 1
        continue
    }
    if ($ch -eq '{') { $stack += @{ch=$ch; line=$line; col=$col; idx=$i}; continue }
    if ($ch -eq '}') {
        if ($stack.Count -eq 0) { Write-Output "Unmatched } at line $line col $col"; continue }
        $stack = $stack[0..($stack.Count-2)]
        continue
    }
}
if ($stack.Count -gt 0) {
    Write-Output "Unmatched { found:"
    foreach ($s in $stack) { Write-Output "  at line $($s.line) col $($s.col)" }
} else {
    Write-Output "All braces matched"
}
