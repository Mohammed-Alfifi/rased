"""The fight classifier: a small bidirectional GRU over pose-feature windows."""
from __future__ import annotations

import torch
from torch import nn


class FightNet(nn.Module):
    def __init__(self, in_dim: int = 170, hidden: int = 128, layers: int = 2, dropout: float = 0.3) -> None:
        super().__init__()
        self.norm = nn.LayerNorm(in_dim)
        self.proj = nn.Sequential(nn.Linear(in_dim, hidden), nn.GELU(), nn.Dropout(dropout))
        self.gru = nn.GRU(hidden, hidden, num_layers=layers, batch_first=True, bidirectional=True,
                          dropout=dropout if layers > 1 else 0.0)
        self.head = nn.Sequential(nn.Linear(4 * hidden, hidden), nn.GELU(), nn.Dropout(dropout), nn.Linear(hidden, 1))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """x: (batch, time, features) -> logits (batch,)"""
        h, _ = self.gru(self.proj(self.norm(x)))
        pooled = torch.cat([h.mean(dim=1), h.max(dim=1).values], dim=1)
        return self.head(pooled).squeeze(1)


class FightNetProb(nn.Module):
    """Export wrapper: outputs a probability, which is what the vision service reads."""

    def __init__(self, net: FightNet) -> None:
        super().__init__()
        self.net = net

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return torch.sigmoid(self.net(x))
