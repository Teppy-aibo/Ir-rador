"""指定した銘柄の日足の形を一覧にする（11/20 株探「一目均衡表 買いシグナル 低PER」とレアアース関連のふるい分け）。
GitHub Actions の heavy-check から手動で動かす。結果は Summary（表）と成果物（CSV）。
見る数字: 終値・前日比・5/25/75/200日線との位置・25日線の向き（5日前比）・52週高値からの距離・20日騰落・出来高（5日平均/20日平均）・RSI14。
"""
from __future__ import annotations
import argparse, os
from pathlib import Path
import pandas as pd
import yfinance as yf

OUT = Path(os.environ.get("OUT_DIR", "out"))
CODES = {
    # 一目均衡表 買いシグナル 低PER（株探 11/19版）
    "3486": "グローバルLM 不動産", "8281": "ゼビオ 小売", "8425": "みずほリース", "2429": "ワールドHD",
    "7419": "ノジマ", "8253": "クレセゾン", "1814": "大末建設 建設", "7593": "VTHD",
    "3443": "川田テク 建設(橋梁)", "1780": "ヤマウラ 建設", "256A": "飛島HD 建設", "1938": "日本リーテック 建設(鉄道電気)",
    "4064": "日本カーバイド", "6418": "日本金銭機械", "7537": "丸文", "5930": "文化シヤッター 建材",
    "9622": "スペース 内装", "3569": "セーレン", "9882": "イエローハット", "4931": "新日本製薬 医療寄り",
    "8273": "イズミ", "2207": "meito", "1926": "ライト工業 建設", "6167": "冨士ダイス",
    "4481": "ベース", "5947": "リンナイ 住宅設備", "9044": "南海電鉄", "3360": "シップHD 医療",
    # レアアース関連6銘柄
    "5706": "三井金属 レアアース", "5714": "DOWA 環境リサイクル", "5471": "大同特殊鋼 レアアース",
    "2768": "双日 レアアース", "8088": "岩谷産業 レアアース", "6330": "東洋エンジ レアアース",
}

def rsi(s, n=14):
    d = s.diff(); up = d.clip(lower=0).ewm(alpha=1/n).mean(); dn = (-d.clip(upper=0)).ewm(alpha=1/n).mean()
    return 100 - 100/(1+up/dn)

def main():
    argparse.ArgumentParser().add_argument("--universe", default="").parse_known_args()
    OUT.mkdir(exist_ok=True)
    rows = []
    for c, name in CODES.items():
        try:
            df = yf.download(f"{c}.T", period="2y", interval="1d", auto_adjust=False, progress=False)
            if isinstance(df.columns, pd.MultiIndex): df.columns = df.columns.get_level_values(0)
            df = df.dropna(subset=["Close"])
            if len(df) < 80: raise ValueError(f"rows {len(df)}")
            cl, v = df["Close"], df["Volume"]
            ma = {n: cl.rolling(n).mean() for n in (5, 25, 75, 200)}
            last = cl.iloc[-1]
            hi52 = df["High"].iloc[-250:].max()
            rows.append({
                "コード": c, "銘柄": name, "日付": df.index[-1].strftime("%m/%d"), "終値": round(last, 1),
                "前日比%": round((last/cl.iloc[-2]-1)*100, 2),
                "5日線比%": round((last/ma[5].iloc[-1]-1)*100, 1),
                "25日線比%": round((last/ma[25].iloc[-1]-1)*100, 1),
                "75日線比%": round((last/ma[75].iloc[-1]-1)*100, 1),
                "200日線比%": round((last/ma[200].iloc[-1]-1)*100, 1) if pd.notna(ma[200].iloc[-1]) else None,
                "25日線の向き%(5日)": round((ma[25].iloc[-1]/ma[25].iloc[-6]-1)*100, 2),
                "75日線の向き%(5日)": round((ma[75].iloc[-1]/ma[75].iloc[-6]-1)*100, 2),
                "52週高値比%": round((last/hi52-1)*100, 1),
                "20日騰落%": round((last/cl.iloc[-21]-1)*100, 1),
                "出来高5/20": round(v.iloc[-5:].mean()/v.iloc[-20:].mean(), 2),
                "RSI14": round(rsi(cl).iloc[-1], 0),
                "売買代金(億,20日平均)": round((cl*v).iloc[-20:].mean()/1e8, 1),
            })
        except Exception as e:
            rows.append({"コード": c, "銘柄": name, "日付": f"取得失敗 {e}"})
    out = pd.DataFrame(rows)
    out.to_csv(OUT/"stock_snapshot.csv", index=False, encoding="utf-8-sig")
    md = "## 日足の形の一覧\n\n" + out.to_markdown(index=False)
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f: f.write(md + "\n")

if __name__ == "__main__":
    main()
