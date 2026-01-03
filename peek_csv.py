import pandas as pd
import os

folder = r"d:\ИГРА ОПУС\whale_bot_js\data\history"
files = [
    "trades_2025-12-21.csv",
    "trades_ml_2025-12-26.csv"
]

for f in files:
    path = os.path.join(folder, f)
    if os.path.exists(path):
        print(f"\n--- {f} ---")
        try:
            df = pd.read_csv(path, nrows=3)
            print(df.columns.tolist())
            print(df.head(1).to_string(index=False))
        except Exception as e:
            print(f"Error reading {f}: {e}")
    else:
        print(f"File not found: {path}")
