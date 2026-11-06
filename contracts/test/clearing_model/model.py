"""Exact-rational design oracle, not a v4 simulator or production solver.

Pool math assumes constant active liquidity, no tick crossings, and a static fee.
Allocation and payout arithmetic use integer raw token units. No float arithmetic.
Run: python3 -m unittest discover -s contracts/test/clearing_model -v
"""
from dataclasses import dataclass
from math import gcd
from fractions import Fraction as F


def floor(value):
    return value.numerator // value.denominator


def ceil(value):
    return -(-value.numerator // value.denominator)


@dataclass(frozen=True)
class Order:
    sell: bool
    amount: int
    minimum: int

    def __post_init__(self):
        if self.amount <= 0 or self.minimum < 0:
            raise ValueError("model accepts positive, funded orders only")

    def output(self, filled, price):
        if price <= 0 or not 0 <= filled <= self.amount:
            raise ValueError("invalid price or input")
        return floor(filled * price if self.sell else F(filled) / price)

    def minimum_for(self, filled):
        # Never silently weaken a proportional user limit by rounding down.
        return ceil(F(self.minimum * filled, self.amount))

    def eligible(self, price):
        return self.output(self.amount, price) >= max(1, self.minimum)

    def same_limit(self, other):
        return (self.sell == other.sell and
                self.minimum * other.amount == other.minimum * self.amount)


def prorata(orders, numerator, denominator):
    """One fraction for an equal-limit group; rounding dust stays with owners.

    Independent flooring makes allocation permutation invariant. No privileged
    last order receives the rounding remainder. No minimum-output relaxation.
    """
    if denominator <= 0 or not 0 <= numerator <= denominator:
        raise ValueError("invalid fraction")
    if orders and any(not orders[0].same_limit(o) for o in orders):
        raise ValueError("not an equal-limit group")
    return tuple((o.amount * numerator // denominator) // (o.amount // gcd(o.amount, o.minimum)) *
                 (o.amount // gcd(o.amount, o.minimum)) for o in orders)


@dataclass(frozen=True)
class Pool:
    x: int
    y: int
    fee: F = F(3, 1000)

    def __post_init__(self):
        if self.x <= 0 or self.y <= 0 or not 0 <= self.fee < 1:
            raise ValueError("invalid pool")

    @property
    def price(self):
        return F(self.y, self.x)

    def swap(self, sell, amount):
        if amount < 0:
            raise ValueError("negative residual")
        effective = amount * (1 - self.fee)
        if sell:
            output = self.y * effective / (self.x + effective)
            post = F(self.x * self.y) / (self.x + effective) ** 2
        else:
            output = self.x * effective / (self.y + effective)
            post = (self.y + effective) ** 2 / (self.x * self.y)
        # Fee remains outside active virtual reserves, as in the v4 model.
        return floor(output), post


@dataclass(frozen=True)
class Result:
    feasible: bool
    reason: str
    payouts: tuple
    residual_input: int = 0
    residual_output: int = 0
    donation: int = 0
    post_price: F = F(0)
    leftover0: int = 0
    leftover1: int = 0


def evaluate(pool, orders, fills, price, tolerance=F(1, 100)):
    """Check accounting/limits/marginality for explicit fills, not priority.

    Separating feasibility from allocation lets tests expose failures in a
    candidate rule without silently substituting a different fill selection.
    """
    if len(orders) != len(fills) or price <= 0 or tolerance < 0:
        raise ValueError("invalid candidate")
    payouts = tuple(o.output(a, price) for o, a in zip(orders, fills))
    for o, a, out in zip(orders, fills, payouts):
        if a and (out == 0 or out < o.minimum_for(a)):
            return Result(False, "limit-or-dust", payouts)
    in0 = sum(a for o, a in zip(orders, fills) if o.sell)
    in1 = sum(a for o, a in zip(orders, fills) if not o.sell)
    out0 = sum(v for o, v in zip(orders, payouts) if not o.sell)
    out1 = sum(v for o, v in zip(orders, payouts) if o.sell)
    net0, net1 = in0 - out0, in1 - out1
    used = received = donated = 0
    post = pool.price
    if net0 > 0 and net1 < 0:
        used = net0
        received, post = pool.swap(True, used)
        donated = received + net1
        net0, net1 = 0, 0
    elif net1 > 0 and net0 < 0:
        used = net1
        received, post = pool.swap(False, used)
        donated = received + net0
        net0, net1 = 0, 0
    elif net0 < 0 or net1 < 0:
        return Result(False, "imbalance", payouts)
    if donated < 0:
        return Result(False, "residual-short", payouts, used, received, donated, post)
    ok = abs(post - price) <= tolerance * price
    return Result(ok, "ok" if ok else "marginal-price", payouts,
                  used, received, donated, post, net0, net1)
