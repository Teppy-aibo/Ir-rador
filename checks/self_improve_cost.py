"""self_improve.py を1回あたりのコスト0.3%（手数料＋すべり＋金利・貸株料のおおよそ）で回す（11/16 コストに耐えるかの確認）。"""

import self_improve

self_improve.COST = 0.3

if __name__ == "__main__":
    print("※ コスト0.3%で計算")
    self_improve.main()
