$content = Get-Content 'functions\\index.js' -Raw 
$content = $content -replace 'YOUR-APP.vercel.app', 'barangaydocs-pcpage.vercel.app' 
Set-Content 'functions\\index.js' $content -Encoding UTF8 
