#!/bin/bash
# Pandoo — double-click to start locally on Mac
cd "$(dirname "$0")"

echo "==============================="
echo "  PANDOO — starting locally..."
echo "==============================="

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Node.js nahi mila. Pehle https://nodejs.org se Node.js (LTS) install karo,"
  echo "phir ye file dobara double-click karo."
  echo ""
  read -p "Band karne ke liye Enter dabao..."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Pehli baar: dependencies install ho rahi hain..."
  npm install || { echo "npm install fail ho gaya."; read -p "Enter dabao..."; exit 1; }
fi

echo ""
echo "Server chal raha hai! Browser me kholo:"
echo "   http://localhost:3000"
echo ""
echo "Band karne ke liye Ctrl+C dabao."
echo ""

npm start
