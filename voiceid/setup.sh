#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Create venv if it doesn't exist
if [ ! -d .venv ]; then
    echo "Creating venv..."
    ~/.local/bin/python3.12 -m venv .venv
fi

# Upgrade pip
echo "Upgrading pip..."
.venv/bin/pip install --upgrade pip

# Install requirements
echo "Installing requirements..."
.venv/bin/pip install -r requirements.txt

# Pre-download model
echo "Pre-downloading ECAPA-TDNN model..."
mkdir -p models
.venv/bin/python -c "from speechbrain.inference.speaker import EncoderClassifier; EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb', savedir='models/ecapa', run_opts={'device':'cpu'})"

echo "Setup complete!"
