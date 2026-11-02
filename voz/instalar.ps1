# Instala el servicio de voz de Tata (Chatterbox Multilingual) en voz\.venv.
# Necesita Python 3.11. Con placa NVIDIA usa la GPU (CUDA 12.4); sin placa, anda en CPU pero lento.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

py -3.11 -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip

$gpu = $null -ne (Get-Command nvidia-smi -ErrorAction SilentlyContinue)
if ($gpu) {
  .\.venv\Scripts\python -m pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124
}
.\.venv\Scripts\python -m pip install -r requirements.txt

Write-Host ''
Write-Host 'Listo. Para arrancarlo:  voz\.venv\Scripts\python voz\servidor.py'
