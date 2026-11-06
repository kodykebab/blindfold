import random
import unittest
from fractions import Fraction as F
from math import gcd
from model import Order, Pool, evaluate, prorata

U = 10**18


class ClearingModelTest(unittest.TestCase):
    def setUp(self):
        self.pool = Pool(10_000 * U, 10_000 * U)

    def test_executable_order_has_no_all_or_none_clearing_price(self):
        o = Order(True, 1000 * U, 900 * U)
        output, post = self.pool.swap(True, o.amount)
        self.assertGreaterEqual(output, o.minimum)
        # Full fill needs p >= .9, but marginality requires p <= post/.99.
        self.assertLess(post / F(99, 100), F(9, 10))
        # Exclusion needs p < .9; unchanged pool requires p >= 1/1.01.
        self.assertGreater(self.pool.price / F(101, 100), F(9, 10))
        self.assertFalse(evaluate(self.pool, [o], [o.amount], F(9, 10)).feasible)
        self.assertFalse(evaluate(self.pool, [o], [0], F(89, 100)).feasible)

    def test_partial_sell_resolves_reproduced_case(self):
        o = Order(True, 1000 * U, 900 * U)
        r = evaluate(self.pool, [o], [540 * U], F(9, 10))
        self.assertTrue(r.feasible, r.reason)
        self.assertEqual(r.payouts, (486 * U,))
        self.assertGreater(r.donation, 0)
        self.assertEqual((r.leftover0, r.leftover1), (0, 0))

    def test_partial_buy_resolves_symmetric_case(self):
        o = Order(False, 1000 * U, 900 * U)
        r = evaluate(self.pool, [o], [540 * U], F(10, 9))
        self.assertTrue(r.feasible, r.reason)
        self.assertEqual(r.payouts, (486 * U,))

    def test_equal_limits_share_one_fraction(self):
        orders = [Order(True, 1000 * U, 900 * U), Order(True, 2000 * U, 1800 * U)]
        fills = prorata(orders, 18, 100)
        self.assertEqual(fills, (180 * U, 360 * U))
        r = evaluate(self.pool, orders, fills, F(9, 10))
        self.assertTrue(r.feasible, r.reason)
        self.assertEqual(r.payouts, (162 * U, 324 * U))

    def test_opposing_flow_nets_before_residual(self):
        orders = [Order(True, 1000 * U, 900 * U), Order(False, 90 * U, 90 * U)]
        r = evaluate(self.pool, orders, [640 * U, 90 * U], F(9, 10))
        self.assertTrue(r.feasible, r.reason)
        self.assertEqual(r.residual_input, 540 * U)
        self.assertEqual(r.payouts, (576 * U, 100 * U))

    def test_balanced_flow_needs_no_pool_fee(self):
        orders = [Order(True, 100 * U, 99 * U), Order(False, 100 * U, 99 * U)]
        r = evaluate(self.pool, orders, [100 * U, 100 * U], F(1))
        self.assertTrue(r.feasible)
        self.assertEqual(r.residual_input, 0)
        self.assertEqual(r.donation, 0)

    def test_exact_post_swap_price_can_be_insolvent_even_without_limits(self):
        o = Order(True, U, 0)
        _, post = self.pool.swap(True, U)
        r = evaluate(self.pool, [o], [U], post, tolerance=F(0))
        self.assertEqual(r.reason, 'residual-short')
        # A fee-aware candidate inside the configured tolerance is feasible.
        r = evaluate(self.pool, [o], [U], F(9969, 10000))
        self.assertTrue(r.feasible, r.reason)

    def test_rounding_down_proportional_minimum_would_weaken_limit(self):
        o = Order(True, 3, 2)
        self.assertEqual(o.minimum_for(2), 2)
        self.assertEqual(o.output(2, F(2, 3)), 1)
        r = evaluate(self.pool, [o], [2], F(2, 3))
        self.assertEqual(r.reason, 'limit-or-dust')
        # This is a real discrete boundary, not permission to reduce the limit.
        self.assertGreater(F(o.minimum_for(2), 2), F(o.minimum, o.amount))

    def test_dust_companion_leaves_executable_group_unblocked(self):
        orders = [Order(True, 1000 * U, 900 * U), Order(True, 10, 9)]
        fills = prorata(orders, 54, 100, F(9, 10))
        self.assertEqual(fills, (540 * U, 0))
        self.assertTrue(evaluate(self.pool, orders, fills, F(9, 10)).feasible)
        self.assertEqual(prorata([Order(True, 40, 39)], 99, 100, F(975, 1000)), (0,))

    def test_zero_output_is_not_a_paid_fill(self):
        r = evaluate(self.pool, [Order(True, 1, 0)], [1], F(1, 2))
        self.assertEqual(r.reason, 'limit-or-dust')

    def test_equal_limit_group_rejects_different_side_or_rate(self):
        a = Order(True, 100, 90)
        for other in (Order(False, 100, 90), Order(True, 100, 91)):
            with self.assertRaises(ValueError):
                prorata([a, other], 1, 2)

    def test_invalid_candidates_fail_explicitly(self):
        o = Order(True, 100, 90)
        for n, d in ((-1, 10), (11, 10), (1, 0)):
            with self.assertRaises(ValueError):
                prorata([o], n, d)
        for amount in (-1, 101):
            with self.assertRaises(ValueError):
                evaluate(self.pool, [o], [amount], F(1))
        with self.assertRaises(ValueError):
            evaluate(self.pool, [o], [], F(1))

    def test_seeded_allocation_invariants(self):
        rng = random.Random(20261106)
        for _ in range(2000):
            base_in, base_out = rng.randint(1, 10000), rng.randint(1, 10000)
            scales = [rng.randint(1, 10000) for _ in range(rng.randint(1, 64))]
            orders = [Order(True, base_in * k, base_out * k) for k in scales]
            denominator = rng.randint(1, 10**9)
            numerator = rng.randint(0, denominator)
            fills = prorata(orders, numerator, denominator)
            self.assertEqual(fills[::-1], prorata(orders[::-1], numerator, denominator))
            for o, filled in zip(orders, fills):
                ideal = F(o.amount * numerator, denominator)
                self.assertLessEqual(filled, ideal)
                self.assertLess(ideal - filled, o.amount // gcd(o.amount, o.minimum))
                self.assertLessEqual(filled, o.amount)
            self.assertLessEqual(sum(fills), sum(o.amount for o in orders) * F(numerator, denominator))

    def test_seeded_partial_limit_and_conservation(self):
        rng = random.Random(42)
        accepted = 0
        for _ in range(1000):
            # Sample a neighborhood of the limit-boundary partial solution.
            amount = rng.randint(500, 570) * U
            order = Order(bool(rng.getrandbits(1)), 1000 * U, 900 * U)
            price = F(9, 10) if order.sell else F(10, 9)
            r = evaluate(self.pool, [order], [amount], price)
            if r.feasible:
                accepted += 1
                self.assertGreaterEqual(r.payouts[0] * order.amount, order.minimum * amount)
                self.assertEqual(r.residual_output, r.payouts[0] + r.donation)
                self.assertEqual(r.residual_input, amount)
                self.assertGreaterEqual(r.donation, 0)
        self.assertGreater(accepted, 100, "feasibility checks must not pass vacuously")


if __name__ == '__main__':
    unittest.main()
