import pandas as pd
import os

path = r"d:\ИГРА ОПУС\whale_bot_js\data\history\trades_ml_2025-12-26.csv"

if os.path.exists(path):
    print(f"\n--- {path} ---")
    try:
        df = pd.read_csv(path, nrows=3)
        print(df.columns.tolist())
    except Exception as e:
        print(f"Error reading {path}: {e}")
else:
    print(f"File not found: {path}")
