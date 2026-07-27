Add-Type -AssemblyName System.Web

$base = "http://localhost:3000/webhook"
$from = "whatsapp%3A%2B254712345678"

function Send-Test {
    param([string]$Label, [string]$Msg)
    Write-Host ""
    Write-Host "===== $Label =====" -ForegroundColor Yellow
    Write-Host "MSG: $Msg" -ForegroundColor Gray
    $encoded = [System.Web.HttpUtility]::UrlEncode($Msg)
    $body = "From=$from&Body=$encoded"
    try {
        $r = Invoke-WebRequest -Uri $base -Method POST -ContentType "application/x-www-form-urlencoded" -Body $body -UseBasicParsing
        Write-Host "HTTP $($r.StatusCode) OK — see server terminal for reply" -ForegroundColor Green
    } catch {
        Write-Host "FAIL: $_" -ForegroundColor Red
    }
    Start-Sleep -Seconds 2
}

Send-Test -Label "1. M-Pesa Buy Goods SMS" -Msg "QHK2X4Y7Z3 Confirmed. Ksh500.00 received from GRACE WANJIKU 0712345678 on 25/7/26 at 2:47 PM. New M-PESA balance is Ksh3,200.00. Till Number 987654."

Send-Test -Label "2. M-Pesa SMS repeat customer" -Msg "SBK9P1M2N4 Confirmed. Ksh1,200.00 received from GRACE WANJIKU 0712345678 on 25/7/26 at 4:15 PM. New M-PESA balance is Ksh4,400.00. Till Number 987654."

Send-Test -Label "3. Cash sale in Swahili" -Msg "nimepokea 150 cash na John"

Send-Test -Label "4. Deni (credit given)" -Msg "nimempa Mary sukari 2kg deni, atalipa kesho"

Send-Test -Label "5. Deni repayment" -Msg "John amenilipa deni yake ya 300"

Send-Test -Label "6. Day-close reconciliation (leo 2000)" -Msg "leo 2000"

Write-Host ""
Write-Host "All tests sent. Check the npm run dev terminal for [DEV REPLY] output." -ForegroundColor Cyan
