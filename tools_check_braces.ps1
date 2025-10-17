$path = 'c:\Users\m-pc\Desktop\project_fixed_\sync-hybrid.js'
$lines = Get-Content -Path $path -Raw -Encoding UTF8 -ErrorAction Stop -PipelineVariable line
$chars = $lines.ToCharArray()
$open = ($chars | Where-Object { $_ -eq '{' }).Count
$close = ($chars | Where-Object { $_ -eq '}' }).Count
Write-Output "total open={$open} close={$close}"
$balance = 0
$ln = 0
Get-Content -Path $path -Encoding UTF8 | ForEach-Object {
    $ln++
    $o = (($_ -split '') | Where-Object { $_ -eq '{' }).Count
    $c = (($_ -split '') | Where-Object { $_ -eq '}' }).Count
    $balance += ($o - $c)
    if ($balance -lt 0) { Write-Output "Negative balance at line $ln"; exit 0 }
}
Write-Output "Final balance=$balance"
