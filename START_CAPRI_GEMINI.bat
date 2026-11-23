@echo off
setlocal EnableExtensions

set "CAPRI_ROOT=D:\code\CapriCore"
set "CAPRI_NODE_DIR=%CAPRI_ROOT%\.runtime\node-v24.22.1-win-x64"
set "CAPRI_NODE_PATH=%CAPRI_NODE_DIR%\node.exe"
set "PATH=%CAPRI_NODE_DIR%;%PATH%"
set "ELECTRON_RUN_AS_NODE="

if not exist "%CAPRI_NODE_PATH%" (
  echo [ERROR] Portable Node v24.22.1 tidak ditemukan di "%CAPRI_NODE_PATH%"
  pause
  exit /b 1
)

echo [1/3] Memastikan Gemini Desktop bridge (127.0.0.1:19824) aktif...
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:19824/status' -TimeoutSec 2; if ($r.success -and $r.hasWebContents) { exit 0 } else { exit 1 } } catch { exit 1 }"
if errorlevel 1 (
  if exist "%LOCALAPPDATA%\Google\Gemini\app-1.21.1\Gemini.exe" (
    powershell -NoProfile -Command "Start-Process -FilePath \"$env:LOCALAPPDATA\Google\Gemini\app-1.21.1\Gemini.exe\" -WindowStyle Minimized; $d=(Get-Date).AddSeconds(30); while((Get-Date)-lt $d){ try{ $r=Invoke-RestMethod 'http://127.0.0.1:19824/status' -TimeoutSec 2; if($r.hasWebContents -and $r.sidecarHealthy){ exit 0 } }catch{}; Start-Sleep -Milliseconds 600 }; exit 1"
  ) else (
    echo [WARN] Gemini.exe tidak ditemukan di "%LOCALAPPDATA%\Google\Gemini\app-1.21.1\Gemini.exe"
  )
)

echo [2/3] Memastikan Gemini-Capri bridge (127.0.0.1:19825) aktif...
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:19825/health' -TimeoutSec 2; if ($r.ok) { exit 0 } else { exit 1 } } catch { exit 1 }"
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%CAPRI_NODE_PATH%' -ArgumentList '%CAPRI_ROOT%\gemini_capri_bridge.mjs' -WorkingDirectory '%CAPRI_ROOT%' -WindowStyle Hidden; $d=(Get-Date).AddSeconds(12); while((Get-Date)-lt $d){ try{ $r=Invoke-RestMethod 'http://127.0.0.1:19825/health' -TimeoutSec 2; if($r.ok){ exit 0 } }catch{}; Start-Sleep -Milliseconds 400 }; exit 1"
)

echo [3/3] Menjalankan official CapriCore Desktop...
powershell -NoProfile -Command "$m='%CAPRI_ROOT%\data\run\desktop.json'; $alive=$false; if(Test-Path $m){ try{ $d=Get-Content -Raw $m|ConvertFrom-Json; if($d.pid -and (Get-Process -Id $d.pid -ErrorAction SilentlyContinue)){ $alive=$true } }catch{} }; if($alive){ & '%CAPRI_NODE_PATH%' '%CAPRI_ROOT%\packages\runtime\bin\capri.mjs' desktop } else { Start-Process -FilePath '%CAPRI_NODE_PATH%' -ArgumentList '%CAPRI_ROOT%\packages\runtime\bin\capri.mjs','desktop','--wait' -WorkingDirectory '%CAPRI_ROOT%' -WindowStyle Hidden }"
exit /b 0
