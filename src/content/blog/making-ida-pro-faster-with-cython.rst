Making IDA Pro Faster with Cython
######################################################
:date: 2025-08-01
:author: Mahmoud
:status: draft
:tags: reverse engineering, cython, ida pro
:classification: blog
:excerpt: Cython and IDA Python for super fast reversing tools

Python is an incredibly powerful language, I would call it a working man language. It's used practically everywhere, ranking 1st or 2nd in popularity indices, right up there with Javascript. All of today's machine learning and AI is built on some combination of Python. It is particularly useful as a tool for security researchers everywhere, de-facto standard for malware analysis and reverse engineering in the three most popular commerical disassemblers today: IDA Pro, Ghidra, and Binary Ninja. The problem is that Python is not the fastest language in the world...not even by a long shot. The internet is littered with articles about how to make Python faster, with various methods ranging from embedding C code, using pybind11/nanobind, using Cython/numba/numpy/jax, distribute compute using multiprocessing, asyncio, etc. Today, I want to talk a bit about Cython.

Cython is a language that allows you to write Python code that is compiled to C. It is a superset of Python, meaning that any valid Python code is also valid Cython code. It is a great way to make Python faster, and it theoretically should be a great way to make IDA Python faster. The premise is really simple: if one adorns python with types the right way, Cython can make your code faster. There are other projects that do this today, some experimental like mypyc, and some more mature like numba for number crunching, but Cython specifically makes it easy to interact with existing C/C++ libraries and write code that is as fast as C, with a language that's *barely* more complex than Python. This works well for IDA Pro, as it's written in C++, and has a rather C-ish non-idiomatic Python API (generated via SWIG). IDA Pro's strength comes from its interactivity (the *I* in IDA stands for interactive!), so using Python for quick scripting is a great solution. However, when dealing with complicated algorithms for deobfuscation and Z3 solvers etc, speed matters and it comes at the expense of REPL-driven development. Making things fast for IDA Pro came at the expense of developer experience and iterative development. It's daunting to pull down a project, with many dependencies and try to contribute back to the community. It's no wonder many plugins for IDA Pro that are written in C go stale after some time but plugins in Python are forked/updated much faster. The barrier to entry to build a community and foster collaboration in Python is much lower than doing it in C/C++. Today, I hope to demonstrate a couple of patterns that make the migration path from writing code in a repl in IDA Python to migrating the slower parts as a super fast C++ plugin, without losing the advantages of Python while gaining the benefits of C++ for the parts that matter.


The first step is to install a profiler to identify the slow parts of the code. However, before we do that, let's just get that sweet dopamine hit of getting things to work and fast without any effort at all. Let's literally just copy and paste our code into a .pyx file and compile it (without using any cdef functions). In most cases it will be as if you were calling the Python C API directly in a compiled C file. In my experience, the biggest difference will be a reduction in the function call overhead so it is better for tight loops.


This is the final pattern for high-performance IDA plugins. You cross the expensive Python/C++ boundary exactly once, run your entire complex algorithm in the fast compiled world, and then return a simple result. This will eliminate the ~330ms of Python loop and function call overhead and should easily bring the total time under your 1-second target.

Here's an example of Python code from a wonderful plugin called d810 that deobfuscates executables by tapping into IDA's internal microcode and running a variety of compiler optimization passes to simplify and optimize the code, which results in deobfuscation. It employs a variety of techniques to make the code fast, but it's *STILL* super slow on large functions.

.. code-block:: python
    from __future__ import annotations

    import abc
    import dataclasses
    import typing

    import ida_hexrays
    import idaapi

    import d810._compat as _compat
    from d810.conf.loggers import getLogger
    from d810.errors import AstEvaluationException
    from d810.expr.utils import (
        MOP_CONSTANT_CACHE,
        MOP_TO_AST_CACHE,
        get_add_cf,
        get_add_of,
        get_parity_flag,
        get_sub_of,
        signed_to_unsigned,
        unsigned_to_signed,
    )
    from d810.hexrays.hexrays_formatters import (
        format_minsn_t,
        format_mop_t,
        mop_tree,
        mop_type_to_string,
        opcode_to_string,
        sanitize_ea,
    )
    from d810.hexrays.hexrays_helpers import (
        AND_TABLE,
        MBA_RELATED_OPCODES,
        MINSN_TO_AST_FORBIDDEN_OPCODES,
        OPCODES_INFO,
        Z3_SPECIAL_OPERANDS,
        equal_mops_ignore_size,
        is_rotate_helper_call,
    )
    from d810.registry import NOT_GIVEN, NotGiven

    logger = getLogger(__name__)

    # ---------------------------------------------------------------------------
    #  Fast-path (Cython) integration
    # ---------------------------------------------------------------------------
    # Toggle to prefer the Cython implementation for building ASTs from microcode.
    # Leave this False by default so we can run both implementations side-by-side
    # and confirm behavior matches before enabling globally.
    use_cython: bool = True

    # Internal flags describing whether the compiled extension is importable & usable.
    _CYTHON_FAST_AST_OK: bool = True

    # The Cython entrypoint signature is:
    #   fast_minsn_to_ast(ins_py, MOP_TO_AST_CACHE, AstProxy, AstNode, AstLeaf, AstConstant, get_constant_mop) -> AstProxy|None
    # We load it lazily at import time and expose small helpers below.
    try:
        # NOTE: this module is generated from `_fast_ast.pyx` at build time
        import d810.expr._fast_ast as _fast_ast

        _cy_fast_minsn_to_ast = _fast_ast.fast_minsn_to_ast
    except Exception as _e:  # pragma: no cover - only hit when extension is missing
        _CYTHON_FAST_AST_OK = False
        if logger.debug_on:
            logger.error("Cython fast AST not available: %r", _e, exc_info=True)


    def cython_available() -> bool:
        """Return True iff the compiled fast path can be used."""
        return _CYTHON_FAST_AST_OK


    def set_use_cython(enabled: bool) -> None:
        """Enable/disable the Cython fast path at runtime."""
        global use_cython
        use_cython = bool(enabled)


    def get_constant_mop(value: int, size: int) -> ida_hexrays.mop_t:
        """
        Returns a cached or new mop_t for a constant value.
        This avoids repeated calls to mop_t.__init__ and make_number.
        """
        key = (value, size)
        if key in MOP_CONSTANT_CACHE:
            return MOP_CONSTANT_CACHE[key]

        # Not in cache, create it once and store it.
        cst_mop = ida_hexrays.mop_t()
        cst_mop.make_number(value, size)
        MOP_CONSTANT_CACHE[key] = cst_mop
        return cst_mop


    def clear_mop_to_ast_cache():
        """
        Call this when the analysis context changes (e.g., new function)
        to prevent using stale data.
        """
        MOP_TO_AST_CACHE.clear()


    @dataclasses.dataclass(slots=True)
    class AstInfo:
        ast: AstNode | AstLeaf
        number_of_use: int

        def __str__(self):
            return f"{self.ast} used {self.number_of_use} times: {format_mop_t(self.ast.mop) if self.ast.mop else 0}"


    class AstBase(abc.ABC):

        sub_ast_info_by_index: dict[int, AstInfo] = {}
        mop: ida_hexrays.mop_t | None = None
        dest_size: int | None = None
        ea: int | None = None
        ast_index: int | None = None

        @property
        @abc.abstractmethod
        def is_frozen(self) -> bool: ...

        @abc.abstractmethod
        def clone(self) -> AstBase: ...

        @abc.abstractmethod
        def freeze(self) -> None: ...

        @abc.abstractmethod
        def is_node(self) -> bool: ...

        @abc.abstractmethod
        def is_leaf(self) -> bool: ...

        @abc.abstractmethod
        def is_constant(self) -> bool: ...

        @abc.abstractmethod
        def compute_sub_ast(self) -> None: ...

        @abc.abstractmethod
        def get_leaf_list(self) -> list[AstLeaf]: ...

        @abc.abstractmethod
        def reset_mops(self) -> None: ...

        @abc.abstractmethod
        def _copy_mops_from_ast(self, other: AstBase, read_only: bool = False) -> bool: ...

        @abc.abstractmethod
        def create_mop(self, ea: int) -> ida_hexrays.mop_t: ...

        @abc.abstractmethod
        def get_pattern(self) -> str: ...

        @abc.abstractmethod
        def evaluate(self, dict_index_to_value: dict[int, int]) -> int: ...

        @abc.abstractmethod
        def get_depth_signature(self, depth: int) -> list[str]: ...

        def __bool__(self) -> bool:
            return True


    class AstNode(AstBase, dict):
        def __init__(
            self,
            opcode: int,
            left: AstBase | None = None,
            right: AstBase | None = None,
            dst: AstBase | None = None,
        ):
            super().__init__()
            self.opcode = opcode
            self.left = left
            self.right = right
            self.dst = dst
            self.dst_mop = None

            self.opcodes = []
            self.mop = None
            self.is_candidate_ok = False

            self.leafs = []
            self.leafs_by_name = {}

            self.ast_index = 0
            self.sub_ast_info_by_index = {}

            self.dest_size = None
            self.ea = None
            self.func_name: str = ""
            self._is_frozen = False  # All newly created nodes are mutable by default

        @property
        @_compat.override
        def is_frozen(self) -> bool:
            return self._is_frozen

        @_compat.override
        def freeze(self):
            """Recursively freezes this node and all its children."""
            if self._is_frozen:
                return
            self._is_frozen = True
            if hasattr(self, "left") and self.left:
                self.left.freeze()
            if hasattr(self, "right") and self.right:
                self.right.freeze()
            if hasattr(self, "dst") and self.dst:
                self.dst.freeze()

        @property
        def size(self):
            return self.mop.d.d.size if self.mop else 0

        def compute_sub_ast(self):
            self.sub_ast_info_by_index = {}
            assert self.ast_index is not None
            self.sub_ast_info_by_index[self.ast_index] = AstInfo(self, 1)

            if self.left is not None:
                self.left.compute_sub_ast()
                for ast_index, ast_info in self.left.sub_ast_info_by_index.items():
                    if ast_index not in self.sub_ast_info_by_index.keys():
                        self.sub_ast_info_by_index[ast_index] = AstInfo(ast_info.ast, 0)
                    self.sub_ast_info_by_index[
                        ast_index
                    ].number_of_use += ast_info.number_of_use

            if self.right is not None:
                self.right.compute_sub_ast()
                for ast_index, ast_info in self.right.sub_ast_info_by_index.items():
                    if ast_index not in self.sub_ast_info_by_index.keys():
                        self.sub_ast_info_by_index[ast_index] = AstInfo(ast_info.ast, 0)
                    self.sub_ast_info_by_index[
                        ast_index
                    ].number_of_use += ast_info.number_of_use

        def get_information(self):
            leaf_info_list = []
            cst_list = []
            opcode_list = []
            self.compute_sub_ast()

            for _, ast_info in self.sub_ast_info_by_index.items():
                if (ast_info.ast.mop is not None) and (
                    ast_info.ast.mop.t != ida_hexrays.mop_z
                ):
                    if ast_info.ast.is_leaf():
                        if ast_info.ast.is_constant():
                            cst_list.append(ast_info.ast.mop.nnn.value)
                        else:
                            leaf_info_list.append(ast_info)
                    else:
                        ast_node = typing.cast(AstNode, ast_info.ast)
                        opcode_list += [ast_node.opcode] * ast_info.number_of_use

            return leaf_info_list, cst_list, opcode_list

        def __getitem__(self, k: str) -> AstLeaf:
            return self.leafs_by_name[k]

        def get_leaf_list(self) -> list[AstLeaf]:
            leafs = []
            if self.left is not None:
                leafs += self.left.get_leaf_list()
            if self.right is not None:
                leafs += self.right.get_leaf_list()
            return leafs

        def add_leaf(self, leaf_name: str, leaf_mop: ida_hexrays.mop_t):
            leaf = AstLeaf(leaf_name)
            leaf.mop = leaf_mop
            self.leafs.append(leaf)
            self.leafs_by_name[leaf_name] = leaf

        def add_constant_leaf(self, leaf_name: str, cst_value: int, cst_size: int):
            masked_value = cst_value & AND_TABLE[cst_size]
            cst_mop = get_constant_mop(masked_value, cst_size)
            self.add_leaf(leaf_name, cst_mop)

        def check_pattern_and_copy_mops(
            self, ast: AstNode | AstLeaf, read_only: bool = False
        ) -> bool:
            if not read_only:
                self.reset_mops()
            if logger.debug_on:
                logger.debug(
                    "AstNode.check_pattern_and_copy_mops from %r",
                    ast,
                )
            is_matching_shape = self._copy_mops_from_ast(ast, read_only)
            if not is_matching_shape:
                return False
            return self._check_implicit_equalities()

        def reset_mops(self):
            self.mop = None
            if self.left is not None:
                self.left.reset_mops()
            if self.right is not None:
                self.right.reset_mops()

        def _copy_mops_from_ast(
            self, other: AstNode | AstLeaf, read_only: bool = False
        ) -> bool:
            if not other.is_node():
                return False
            other = typing.cast(AstNode, other)
            if self.opcode != other.opcode:
                return False

            if not read_only:
                self.mop = other.mop
                self.dst_mop = other.dst_mop
                self.dest_size = other.dest_size
                self.ea = other.ea

            if logger.debug_on:
                logger.debug(
                    "AstNode._copy_mops_from_ast: self.left: %r, other.left: %r",
                    self.left,
                    other.left,
                )
            if self.left is not None and other.left is not None:
                if not self.left._copy_mops_from_ast(other.left, read_only):
                    return False
            if logger.debug_on:
                logger.debug(
                    "AstNode._copy_mops_from_ast: self.right: %r, other.right: %r",
                    self.right,
                    other.right,
                )
            if self.right is not None and other.right is not None:
                if not self.right._copy_mops_from_ast(other.right, read_only):
                    return False
            return True

        def _check_implicit_equalities(self) -> bool:
            self.leafs = self.get_leaf_list()
            self.leafs_by_name = {}
            self.is_candidate_ok = True

            for leaf in self.leafs:
                ref_leaf = self.leafs_by_name.get(leaf.name)
                if ref_leaf is not None and leaf.mop is not None:
                    if not equal_mops_ignore_size(ref_leaf.mop, leaf.mop):
                        self.is_candidate_ok = False
                self.leafs_by_name[leaf.name] = leaf
            return self.is_candidate_ok

        def update_leafs_mop(
            self,
            other: AstNode,
            other2: AstNode | None = None,
        ) -> bool:
            self.leafs = self.get_leaf_list()
            all_leafs_found = True
            for leaf in self.leafs:
                if other is not None and leaf.name in other.leafs_by_name:
                    leaf.mop = other.leafs_by_name[leaf.name].mop
                elif other2 is not None and leaf.name in other2.leafs_by_name:
                    leaf.mop = other2.leafs_by_name[leaf.name].mop
                else:
                    all_leafs_found = False
            return all_leafs_found

        def create_mop(self, ea: int) -> ida_hexrays.mop_t:
            new_ins = self.create_minsn(ea)
            new_ins_mop = ida_hexrays.mop_t()
            new_ins_mop.create_from_insn(new_ins)
            return new_ins_mop

        def create_minsn(self, ea: int, dest=None) -> ida_hexrays.minsn_t:
            new_ins = ida_hexrays.minsn_t(ea)
            new_ins.opcode = self.opcode

            if self.left is not None:
                new_ins.l = self.left.create_mop(ea)
                if self.right is not None:
                    new_ins.r = self.right.create_mop(ea)

            new_ins.d = ida_hexrays.mop_t()

            if self.left is not None:
                new_ins.d.size = new_ins.l.size
            if dest is not None:
                new_ins.d = dest
            return new_ins

        def get_pattern(self) -> str:
            nb_operands = OPCODES_INFO[self.opcode]["nb_operands"]
            if nb_operands == 0:
                return "AstNode({0})".format(OPCODES_INFO[self.opcode]["name"])
            elif nb_operands == 1 and self.left is not None:
                return "AstNode(m_{0}, {1})".format(
                    OPCODES_INFO[self.opcode]["name"], self.left.get_pattern()
                )
            elif nb_operands == 2 and self.left is not None and self.right is not None:
                return "AstNode(m_{0}, {1}, {2})".format(
                    OPCODES_INFO[self.opcode]["name"],
                    self.left.get_pattern(),
                    self.right.get_pattern(),
                )
            else:
                raise ValueError(f"Invalid number of operands: {nb_operands}")

        def evaluate_with_leaf_info(
            self, leafs_info: list[AstInfo], leafs_value: list[int]
        ) -> int:
            dict_index_to_value: dict[int, int] = {}
            for leaf_info, leaf_value in zip(leafs_info, leafs_value):
                if leaf_info.ast.ast_index is not None:
                    dict_index_to_value[leaf_info.ast.ast_index] = leaf_value
            res = self.evaluate(dict_index_to_value)
            return res

        def evaluate(self, dict_index_to_value: dict[int, int]) -> int:
            if self.ast_index in dict_index_to_value:
                return dict_index_to_value[self.ast_index]
            if self.dest_size is None:
                raise ValueError("dest_size is None")

            res_mask = AND_TABLE[self.dest_size]

            if self.left is None:
                raise ValueError(f"left is None for opcode: {self.opcode}")

            binary_opcodes = {
                ida_hexrays.m_add,
                ida_hexrays.m_sub,
                ida_hexrays.m_mul,
                ida_hexrays.m_udiv,
                ida_hexrays.m_sdiv,
                ida_hexrays.m_umod,
                ida_hexrays.m_smod,
                ida_hexrays.m_or,
                ida_hexrays.m_and,
                ida_hexrays.m_xor,
                ida_hexrays.m_shl,
                ida_hexrays.m_shr,
                ida_hexrays.m_sar,
                ida_hexrays.m_cfadd,
                ida_hexrays.m_ofadd,
                ida_hexrays.m_seto,
                ida_hexrays.m_setnz,
                ida_hexrays.m_setz,
                ida_hexrays.m_setae,
                ida_hexrays.m_setb,
                ida_hexrays.m_seta,
                ida_hexrays.m_setbe,
                ida_hexrays.m_setg,
                ida_hexrays.m_setge,
                ida_hexrays.m_setl,
                ida_hexrays.m_setle,
                ida_hexrays.m_setp,
            }

            if self.opcode in binary_opcodes and self.right is None:
                raise ValueError("right is None for binary opcode: {0}".format(self.opcode))

            match self.opcode:
                case ida_hexrays.m_mov:
                    return (self.left.evaluate(dict_index_to_value)) & res_mask
                case ida_hexrays.m_neg:
                    return (-self.left.evaluate(dict_index_to_value)) & res_mask
                case ida_hexrays.m_lnot:
                    return self.left.evaluate(dict_index_to_value) != 0
                case ida_hexrays.m_bnot:
                    return (self.left.evaluate(dict_index_to_value) ^ res_mask) & res_mask
                case ida_hexrays.m_xds:
                    left_value_signed = unsigned_to_signed(
                        self.left.evaluate(dict_index_to_value), self.left.dest_size
                    )
                    return signed_to_unsigned(left_value_signed, self.dest_size) & res_mask
                case ida_hexrays.m_xdu:
                    return (self.left.evaluate(dict_index_to_value)) & res_mask
                case ida_hexrays.m_low:
                    return (self.left.evaluate(dict_index_to_value)) & res_mask
                case ida_hexrays.m_high:
                    # Extract the upper half of the operand. We shift right by the
                    # size (in bits) of the current destination. For example, when
                    # evaluating a 32-bit "high" of a 64-bit operand we shift by
                    # 32 bits, then mask the result to the destination size.
                    if self.left.dest_size is None:
                        raise ValueError("left.dest_size is None for m_high")
                    shift_bits = self.dest_size * 8 if self.dest_size is not None else 0
                    return (
                        self.left.evaluate(dict_index_to_value) >> shift_bits
                    ) & res_mask
                case ida_hexrays.m_add if self.right is not None:
                    return (
                        self.left.evaluate(dict_index_to_value)
                        + self.right.evaluate(dict_index_to_value)
                    ) & res_mask
                case ida_hexrays.m_sub if self.right is not None:
                    return (
                        self.left.evaluate(dict_index_to_value)
                        - self.right.evaluate(dict_index_to_value)
                    ) & res_mask
                case ida_hexrays.m_mul if self.right is not None:
                    return (
                        self.left.evaluate(dict_index_to_value)
                        * self.right.evaluate(dict_index_to_value)
                    ) & res_mask
                case ida_hexrays.m_udiv if self.right is not None:
                    return (
                        self.left.evaluate(dict_index_to_value)
                        // self.right.evaluate(dict_index_to_value)
                    ) & res_mask
                case ida_hexrays.m_sdiv if self.right is not None:
                    return (
                        self.left.evaluate(dict_index_to_value)
                        // self.right.evaluate(dict_index_to_value)
                    ) & res_mask
                case ida_hexrays.m_umod if self.right is not None:
                    return (
                        self.left.evaluate(dict_index_to_value)
                        % self.right.evaluate(dict_index_to_value)
                    ) & res_mask
                case ida_hexrays.m_smod if self.right is not None:
                    return (
                        self.left.evaluate(dict_index_to_value)
                        % self.right.evaluate(dict_index_to_value)
                    ) & res_mask
                case ida_hexrays.m_or if self.right is not None:
                    return (
                        self.left.evaluate(dict_index_to_value)
                        | self.right.evaluate(dict_index_to_value)
                    ) & res_mask
                case ida_hexrays.m_and if self.right is not None:
                    return (
                        self.left.evaluate(dict_index_to_value)
                        & self.right.evaluate(dict_index_to_value)
                    ) & res_mask
                case ida_hexrays.m_xor if self.right is not None:
                    return (
                        self.left.evaluate(dict_index_to_value)
                        ^ self.right.evaluate(dict_index_to_value)
                    ) & res_mask
                case ida_hexrays.m_shl if self.right is not None:
                    return (
                        self.left.evaluate(dict_index_to_value)
                        << self.right.evaluate(dict_index_to_value)
                    ) & res_mask
                case ida_hexrays.m_shr if self.right is not None:
                    return (
                        self.left.evaluate(dict_index_to_value)
                        >> self.right.evaluate(dict_index_to_value)
                    ) & res_mask
                case ida_hexrays.m_sar if self.right is not None:
                    left_value_signed = unsigned_to_signed(
                        self.left.evaluate(dict_index_to_value), self.left.dest_size
                    )
                    res_signed = left_value_signed >> self.right.evaluate(
                        dict_index_to_value
                    )
                    return signed_to_unsigned(res_signed, self.dest_size) & res_mask
                case ida_hexrays.m_cfadd if self.right is not None:
                    tmp = get_add_cf(
                        self.left.evaluate(dict_index_to_value),
                        self.right.evaluate(dict_index_to_value),
                        self.left.dest_size,
                    )
                    return tmp & res_mask
                case ida_hexrays.m_ofadd if self.right is not None:
                    tmp = get_add_of(
                        self.left.evaluate(dict_index_to_value),
                        self.right.evaluate(dict_index_to_value),
                        self.left.dest_size,
                    )
                    return tmp & res_mask
                case ida_hexrays.m_sets:
                    left_value_signed = unsigned_to_signed(
                        self.left.evaluate(dict_index_to_value), self.left.dest_size
                    )
                    res = 1 if left_value_signed < 0 else 0
                    return res & res_mask
                case ida_hexrays.m_seto if self.right is not None:
                    left_value_signed = unsigned_to_signed(
                        self.left.evaluate(dict_index_to_value), self.left.dest_size
                    )
                    right_value_signed = unsigned_to_signed(
                        self.right.evaluate(dict_index_to_value), self.right.dest_size
                    )
                    sub_overflow = get_sub_of(
                        left_value_signed, right_value_signed, self.left.dest_size
                    )
                    return sub_overflow & res_mask
                case ida_hexrays.m_setnz if self.right is not None:
                    res = (
                        1
                        if self.left.evaluate(dict_index_to_value)
                        != self.right.evaluate(dict_index_to_value)
                        else 0
                    )
                    return res & res_mask
                case ida_hexrays.m_setz if self.right is not None:
                    res = (
                        1
                        if self.left.evaluate(dict_index_to_value)
                        == self.right.evaluate(dict_index_to_value)
                        else 0
                    )
                    return res & res_mask
                case ida_hexrays.m_setae if self.right is not None:
                    res = (
                        1
                        if self.left.evaluate(dict_index_to_value)
                        >= self.right.evaluate(dict_index_to_value)
                        else 0
                    )
                    return res & res_mask
                case ida_hexrays.m_setb if self.right is not None:
                    res = (
                        1
                        if self.left.evaluate(dict_index_to_value)
                        < self.right.evaluate(dict_index_to_value)
                        else 0
                    )
                    return res & res_mask
                case ida_hexrays.m_seta if self.right is not None:
                    res = (
                        1
                        if self.left.evaluate(dict_index_to_value)
                        > self.right.evaluate(dict_index_to_value)
                        else 0
                    )
                    return res & res_mask
                case ida_hexrays.m_setbe if self.right is not None:
                    res = (
                        1
                        if self.left.evaluate(dict_index_to_value)
                        <= self.right.evaluate(dict_index_to_value)
                        else 0
                    )
                    return res & res_mask
                case ida_hexrays.m_setg if self.right is not None:
                    left_value_signed = unsigned_to_signed(
                        self.left.evaluate(dict_index_to_value), self.left.dest_size
                    )
                    right_value_signed = unsigned_to_signed(
                        self.right.evaluate(dict_index_to_value), self.right.dest_size
                    )
                    res = 1 if left_value_signed > right_value_signed else 0
                    return res & res_mask
                case ida_hexrays.m_setge if self.right is not None:
                    left_value_signed = unsigned_to_signed(
                        self.left.evaluate(dict_index_to_value), self.left.dest_size
                    )
                    right_value_signed = unsigned_to_signed(
                        self.right.evaluate(dict_index_to_value), self.right.dest_size
                    )
                    res = 1 if left_value_signed >= right_value_signed else 0
                    return res & res_mask
                case ida_hexrays.m_setl if self.right is not None:
                    left_value_signed = unsigned_to_signed(
                        self.left.evaluate(dict_index_to_value), self.left.dest_size
                    )
                    right_value_signed = unsigned_to_signed(
                        self.right.evaluate(dict_index_to_value), self.right.dest_size
                    )
                    res = 1 if left_value_signed < right_value_signed else 0
                    return res & res_mask
                case ida_hexrays.m_setle if self.right is not None:
                    left_value_signed = unsigned_to_signed(
                        self.left.evaluate(dict_index_to_value), self.left.dest_size
                    )
                    right_value_signed = unsigned_to_signed(
                        self.right.evaluate(dict_index_to_value), self.right.dest_size
                    )
                    res = 1 if left_value_signed <= right_value_signed else 0
                    return res & res_mask
                case ida_hexrays.m_setp if self.right is not None:
                    res = get_parity_flag(
                        self.left.evaluate(dict_index_to_value),
                        self.right.evaluate(dict_index_to_value),
                        self.left.dest_size,
                    )
                    return res & res_mask
                case ida_hexrays.m_call:
                    if logger.debug_on:
                        logger.debug(
                            "evaluate m_call: ast_index=%s, dest_size=%s, callee=%s, args=%s",
                            self.ast_index,
                            self.dest_size,
                            self.left,
                            self.right,
                        )
                    # Unknown runtime value – treat as 0 to let constant evaluation proceed.
                    return 0 & res_mask
                case _:
                    raise AstEvaluationException(
                        "Can't evaluate opcode: {0}".format(self.opcode)
                    )

        def get_depth_signature(self, depth):
            if depth == 1:
                return ["{0}".format(self.opcode)]
            tmp = []
            nb_operands = OPCODES_INFO[self.opcode]["nb_operands"]
            if (nb_operands >= 1) and self.left is not None:
                tmp += self.left.get_depth_signature(depth - 1)
            else:
                tmp += ["N"] * (2 ** (depth - 2))
            if (nb_operands >= 2) and self.right is not None:
                tmp += self.right.get_depth_signature(depth - 1)
            else:
                tmp += ["N"] * (2 ** (depth - 2))
            return tmp

        def __str__(self):
            try:
                nb_operands = OPCODES_INFO[self.opcode]["nb_operands"]
                if "symbol" in OPCODES_INFO[self.opcode].keys():
                    if nb_operands == 0:
                        return "{0}()".format(OPCODES_INFO[self.opcode]["symbol"])
                    elif nb_operands == 1:
                        return "{0}({1})".format(
                            OPCODES_INFO[self.opcode]["symbol"], self.left
                        )
                    elif nb_operands == 2:
                        if OPCODES_INFO[self.opcode]["symbol"] not in Z3_SPECIAL_OPERANDS:
                            return "({1} {0} {2})".format(
                                OPCODES_INFO[self.opcode]["symbol"], self.left, self.right
                            )
                        else:
                            return "{0}({1}, {2})".format(
                                OPCODES_INFO[self.opcode]["symbol"], self.left, self.right
                            )
                else:
                    if nb_operands == 0:
                        return "{0}()".format(OPCODES_INFO[self.opcode]["name"])
                    elif nb_operands == 1:
                        return "{0}({1})".format(
                            OPCODES_INFO[self.opcode]["name"], self.left
                        )
                    elif nb_operands == 2:
                        return "{0}({1}, {2})".format(
                            OPCODES_INFO[self.opcode]["name"], self.left, self.right
                        )
            except RuntimeError as e:
                logger.info("Error while calling __str__ on AstNode: {0}".format(e))
            return "Error_AstNode"

        def __repr__(self):
            return f"AstNode({opcode_to_string(self.opcode)}, left={self.left}, right={self.right})"

        @_compat.override
        def clone(self):
            # Use __new__ to bypass __init__ for speed
            new_node = self.__class__.__new__(self.__class__)
            super(AstNode, new_node).__init__()  # Initialize the dict part

            # Manually copy attributes and clone children
            new_node.opcode = self.opcode
            new_node.left = self.left.clone() if self.left else None
            new_node.right = self.right.clone() if self.right else None
            new_node.dst = self.dst.clone() if self.dst else None

            new_node.mop = self.mop
            new_node.dst_mop = self.dst_mop
            new_node.dest_size = self.dest_size
            new_node.ea = self.ea
            new_node.ast_index = self.ast_index

            # Initialize transient state
            new_node.is_candidate_ok = False
            new_node.leafs = []
            new_node.leafs_by_name = {}
            new_node.opcodes = []
            new_node.sub_ast_info_by_index = {}  # Start fresh

            # Cloned objects start mutable
            new_node._is_frozen = False

            return new_node

        @_compat.override
        def is_node(self):
            return True

        @_compat.override
        def is_leaf(self):
            # An AstNode is not a leaf, so returns False
            return False

        @_compat.override
        def is_constant(self):
            return False


    class AstLeaf(AstBase):
        def __init__(self, name):
            self.name = name
            self.ast_index: int | None = None

            self.mop = None
            self.z3_var = None
            self.z3_var_name: str | NotGiven = NOT_GIVEN

            self.dest_size = None
            self.ea = None
            self._is_frozen = False  # All newly created nodes are mutable by default
            self.sub_ast_info_by_index = {}

        @property
        @_compat.override
        def is_frozen(self) -> bool:
            return self._is_frozen

        @_compat.override
        def freeze(self):
            """Recursively freezes this node and all its children."""
            if self._is_frozen:
                return
            self._is_frozen = True

        @_compat.override
        def is_node(self):
            return False

        @_compat.override
        def is_leaf(self):
            return True

        @_compat.override
        def is_constant(self):
            if self.mop is None:
                return False
            return self.mop.t == ida_hexrays.mop_n

        @_compat.override
        def clone(self):
            # Use __new__ to bypass __init__ for speed
            new_leaf = self.__class__.__new__(self.__class__)

            # Manually copy attributes. This is faster than generic deepcopy.
            new_leaf.name = self.name
            new_leaf.ast_index = self.ast_index
            new_leaf.mop = self.mop
            new_leaf.dest_size = self.dest_size
            new_leaf.ea = self.ea

            # Initialize transient state
            new_leaf.z3_var = None
            new_leaf.z3_var_name = NOT_GIVEN
            new_leaf.sub_ast_info_by_index = {}  # Start fresh

            # Cloned objects start mutable by definition
            new_leaf._is_frozen = False

            return new_leaf

        def __getitem__(self, name: str) -> AstLeaf:
            if name == self.name:
                return self
            raise KeyError

        @property
        def size(self):
            return self.mop.size if self.mop else 0

        @property
        def dst_mop(self):
            return self.mop

        @dst_mop.setter
        def dst_mop(self, mop):
            self.mop = mop

        @property
        def value(self):
            if self.is_constant() and self.mop is not None:
                return self.mop.nnn.value
            else:
                return None

        def compute_sub_ast(self):
            self.sub_ast_info_by_index = {}
            assert self.ast_index is not None
            self.sub_ast_info_by_index[self.ast_index] = AstInfo(self, 1)

        def get_information(self):
            # Just here to allow calling get_information on either a AstNode or AstLeaf
            return [], [], []

        def get_leaf_list(self):
            return [self]

        def create_mop(self, ea):
            # 1. Constant operands can keep using the shared cache
            if self.is_constant() and self.value is not None:
                # TODO: is this right?
                size = self.dest_size if self.dest_size is not None else self.size
                if logger.debug_on:
                    logger.debug(
                        "AstLeaf.create_mop: Constant operand @ 0x%x: %s, size: %s, dest_size: %s, equal? %s",
                        ea,
                        self.value,
                        size,
                        self.dest_size,
                        size == self.dest_size,
                    )
                val = get_constant_mop(self.value, size)
                if logger.debug_on:
                    logger.debug(
                        "AstLeaf.create_mop: Constant operand reused: %s",
                        val,
                        extra={"ea": hex(ea)},
                    )
                return val

            if self.mop is None:
                logger.error(
                    "%r mop is None in create_mop for 0x%x",
                    self,
                    ea,
                )
                raise AstEvaluationException(
                    f"{repr(self)}'s mop is None in create_mop for {hex(ea)}"
                )

            # 2. Otherwise, we need to create a new mop
            new_mop = ida_hexrays.mop_t()
            new_mop.assign(self.mop)
            return new_mop  # duplicates the C++ object

        def update_leafs_mop(self, other: AstNode, other2: AstNode | None = None):
            if other is not None and self.name in other.leafs_by_name:
                self.mop = other.leafs_by_name[self.name].mop
                return True
            elif other2 is not None and self.name in other2.leafs_by_name:
                self.mop = other2.leafs_by_name[self.name].mop
                return True
            return False

        def check_pattern_and_copy_mops(self, ast, read_only: bool = False):
            if not read_only:
                self.reset_mops()
            is_matching_shape = self._copy_mops_from_ast(ast, read_only)

            if not is_matching_shape:
                return False
            return self._check_implicit_equalities()

        def reset_mops(self):
            self.z3_var = None
            self.z3_var_name = NOT_GIVEN
            self.mop = None

        def _copy_mops_from_ast(self, other, read_only: bool = False):
            if other.mop is None:
                if logger.debug_on:
                    logger.debug(
                        "AstLeaf._copy_mops_from_ast: other %r's mop is None",
                        other,
                    )
                return False
            if logger.debug_on:
                logger.debug(
                    "AstLeaf._copy_mops_from_ast: other %r's mop %s is not None",
                    other,
                    format_mop_t(other.mop),
                )
            if not read_only:
                self.mop = other.mop
            return True

        @staticmethod
        def _check_implicit_equalities():
            # An AstLeaf does not have any implicit equalities to be checked, so we always returns True
            return True

        def get_pattern(self):
            if self.is_constant() and self.mop is not None:
                return "AstConstant('{0}', {0})".format(self.mop.nnn.value)
            if self.ast_index is not None:
                return "AstLeaf('x_{0}')".format(self.ast_index)
            if self.name is not None:
                return "AstLeaf('{0}')".format(self.name)

        def evaluate_with_leaf_info(self, leafs_info, leafs_value):
            dict_index_to_value = {
                leaf_info.ast.ast_index: leaf_value
                for leaf_info, leaf_value in zip(leafs_info, leafs_value)
            }
            res = self.evaluate(dict_index_to_value)
            return res

        def evaluate(self, dict_index_to_value):
            if self.is_constant() and self.mop is not None:
                return self.mop.nnn.value
            assert self.ast_index is not None
            return dict_index_to_value.get(self.ast_index)

        def get_depth_signature(self, depth):
            if depth == 1:
                if self.is_constant():
                    return ["C"]
                return ["L"]
            else:
                return ["N"] * (2 ** (depth - 1))

        def __str__(self):
            try:
                if self.is_constant() and self.mop is not None:
                    return "{0}".format(hex(self.mop.nnn.value))
                if self.z3_var_name is not NOT_GIVEN:
                    return self.z3_var_name
                if self.ast_index is not None:
                    return "x_{0}".format(self.ast_index)
                if self.mop is not None:
                    return format_mop_t(self.mop)
                return self.name
            except RuntimeError as e:
                logger.info("Error while calling __str__ on AstLeaf: {0}".format(e))
                return "Error_AstLeaf"

        def __repr__(self):
            return f"AstLeaf('{str(self)}')"


    class AstConstant(AstLeaf):
        def __init__(self, name, expected_value=None, expected_size=None):
            super().__init__(name)
            self.expected_value = expected_value
            self.expected_size = expected_size

        @property
        def value(self):
            assert self.mop is not None and self.mop.t == ida_hexrays.mop_n
            return self.mop.nnn.value

        @_compat.override
        def is_constant(self) -> bool:
            # An AstConstant is always constant, so return True
            return True

        def _copy_mops_from_ast(self, other, read_only: bool = False):
            if other.mop is not None and other.mop.t != ida_hexrays.mop_n:
                if logger.debug_on:
                    logger.debug(
                        "AstConstant._copy_mops_from_ast: other.mop is not a constant: %r",
                        other.mop,
                    )
                return False

            if logger.debug_on:
                logger.debug(
                    "AstConstant._copy_mops_from_ast: other %r's mop %s is a constant",
                    other,
                    format_mop_t(other.mop),
                )
            if not read_only:
                self.mop = other.mop
            if self.expected_value is None:
                if not read_only:
                    self.expected_value = other.mop.nnn.value
                    self.expected_size = other.mop.size
                else:
                    return True
            return self.expected_value == other.mop.nnn.value

        def evaluate(self, dict_index_to_value=None):
            if self.mop is not None and self.mop.t == ida_hexrays.mop_n:
                return self.mop.nnn.value
            return self.expected_value

        def get_depth_signature(self, depth):
            if depth == 1:
                return ["C"]
            else:
                return ["N"] * (2 ** (depth - 1))

        @_compat.override
        def __str__(self):
            try:
                if self.mop is not None and self.mop.t == ida_hexrays.mop_n:
                    return "0x{0:x}".format(self.mop.nnn.value)
                if getattr(self, "expected_value", None) is not None:
                    return "0x{0:x}".format(self.expected_value)
                return self.name
            except RuntimeError as e:
                logger.info("Error while calling __str__ on AstConstant: {0}".format(e))
                return "Error_AstConstant"

        @_compat.override
        def __repr__(self):
            return f"AstConstant({str(self)})"


    class AstProxy(AstBase):

        def __init__(self, target_ast: AstBase):
            # The proxy initially holds a reference to the shared, frozen template
            self._target = target_ast

        @property
        @_compat.override
        def is_frozen(self) -> bool:
            return self._target.is_frozen

        @_compat.override
        def clone(self) -> AstBase:
            return AstProxy(self._target.clone())

        @_compat.override
        def freeze(self) -> None:
            self._target.freeze()

        @_compat.override
        def is_node(self) -> bool:
            return self._target.is_node()

        @_compat.override
        def is_leaf(self) -> bool:
            return self._target.is_leaf()

        @_compat.override
        def is_constant(self) -> bool:
            return self._target.is_constant()

        @_compat.override
        def compute_sub_ast(self) -> None:
            self._target.compute_sub_ast()

        @_compat.override
        def get_leaf_list(self) -> list[AstLeaf]:
            return self._target.get_leaf_list()

        @_compat.override
        def reset_mops(self) -> None:
            self._target.reset_mops()

        @_compat.override
        def _copy_mops_from_ast(self, other: AstBase) -> bool:
            return self._target._copy_mops_from_ast(other)

        @_compat.override
        def create_mop(self, ea: int) -> ida_hexrays.mop_t:
            return self._target.create_mop(ea)

        @_compat.override
        def get_pattern(self) -> str:
            return self._target.get_pattern()

        @_compat.override
        def evaluate(self, dict_index_to_value: dict[int, int]) -> int:
            return self._target.evaluate(dict_index_to_value)

        @_compat.override
        def get_depth_signature(self, depth: int) -> list[str]:
            return self._target.get_depth_signature(depth)

        @_compat.override
        def __str__(self):
            return f"AstProxy({self._target.__class__.__name__}({str(self._target)}))"

        @_compat.override
        def __repr__(self):
            return f"AstProxy({repr(self._target)})"

        # Explicitly forward critical leaf data that callers expect to access
        # directly.  Without these properties Python finds the *class*-level
        # attribute defined in AstBase (value = None) and never triggers
        # __getattr__, so evaluators see a leaf with no mop.

        # ‑-- Mop -------------------------------------------------------------
        @property
        def mop(self):  # type: ignore[override]
            return self._target.mop

        @mop.setter
        def mop(self, value):  # noqa: ANN001
            self._ensure_mutable()
            self._target.mop = value

        def _ensure_mutable(self):
            """
            The magic method. If the target is frozen, clone it and
            replace our internal reference with the new, mutable clone.
            """
            if self._target.is_frozen:
                # This is the first write attempt. Time to clone.
                self._target = self._target.clone()  # Assumes clone() exists

        def __getattr__(self, name):
            """
            Handles all read access to attributes (e.g., proxy.opcode, proxy.left).
            """
            # Forward read requests directly to the target (shared or cloned).
            return getattr(self._target, name)

        def __setattr__(self, name, value):
            """
            Handles all write access to attributes (e.g., proxy.ast_index = 5).
            """
            if name == "_target":
                # Special case to allow initialization of the proxy itself.
                self.__dict__["_target"] = value
                return

            # 1. Trigger the clone-on-write check.
            self._ensure_mutable()

            # 2. Perform the write on the (now guaranteed to be mutable) target.
            setattr(self._target, name, value)

        # You might need to proxy other magic methods if your code uses them
        # For example, if you use AstNode as a dict:
        def __getitem__(self, key):
            getitem = getattr(self._target, "__getitem__", None)
            if getitem is None:
                raise AttributeError(
                    f"Object of type {type(self._target)} does not support __getitem__"
                )
            return getitem(key)

        def __setitem__(self, key, value):
            setitem = getattr(self._target, "__setitem__", None)
            if setitem is None:
                raise AttributeError(
                    f"Object of type {type(self._target)} does not support __setitem__"
                )
            self._ensure_mutable()
            setitem(key, value)

        # ------------------------------------------------------------------
        # Transparent attribute forwarding with sane fallback.
        # ------------------------------------------------------------------

        def __getattribute__(self, name):  # noqa: D401, ANN001
            """Forward *all* attribute access to the wrapped target when:
            1) the attribute is not private to the proxy itself, and
            2) the value obtained from the proxy's own namespace is *None*.

            This retains the cheap class-level default attributes coming from
            AstBase (all set to None) while still exposing the real runtime
            values stored in the wrapped AST object.
            """

            # Fast-path: internal/private attributes stay local.
            if name.startswith("_"):
                return super().__getattribute__(name)

            try:
                val = super().__getattribute__(name)
            except AttributeError:
                # Attribute not present on proxy → delegate unconditionally.
                return getattr(super().__getattribute__("_target"), name)

            # If the proxy's value is a meaningless placeholder (None) but the
            # underlying object has a better value, return the latter instead.
            if val is None:
                target = super().__getattribute__("_target")
                return getattr(target, name)
            return val

        # Convenience setters for a few commonly mutated fields
        @property
        def dest_size(self):  # type: ignore[override]
            return self._target.dest_size

        @dest_size.setter
        def dest_size(self, value):  # noqa: ANN001
            self._ensure_mutable()
            self._target.dest_size = value

        @property
        def ea(self):  # type: ignore[override]
            return self._target.ea

        @ea.setter
        def ea(self, value):  # noqa: ANN001
            self._ensure_mutable()
            self._target.ea = value

        @property
        def ast_index(self):  # type: ignore[override]
            return self._target.ast_index

        @ast_index.setter
        def ast_index(self, value):  # noqa: ANN001
            self._ensure_mutable()
            self._target.ast_index = value


    class AstBuilderContext:
        """
        Manages the state during the recursive construction of an AST.
        This avoids passing multiple related arguments through the recursion
        and provides a clean way to store the lookup dictionary.
        """

        def __init__(self):
            # The list of unique AST nodes. The index in this list is the ast_index.
            self.unique_asts: list[AstBase] = []

            # The fast lookup dictionary.
            # Maps a mop's unique key to its index in the unique_asts list.
            self.mop_key_to_index: dict[tuple[int, str], int] = {}


    def get_mop_key(mop: ida_hexrays.mop_t) -> tuple:
        """
        Generates a fast, hashable key from a mop_t's essential attributes.
        This is significantly faster than using mop.dstr().
        """
        t = mop.t

        # Hex-Rays assigns a new SSA value number (valnum) every time an operand is
        # produced, even when it represents the *same* memory/register location.
        # Including valnum in the cache key therefore forces the AST builder to
        # create a distinct AstLeaf for each SSA instance (x_0, x_6, …), which
        # breaks pattern rules that expect a single variable.

        # We drop valnum from the key for all operand kinds except plain numeric
        # constants, where valnum is useful to avoid collisions when two literals
        # share the same size.

        key = (t, mop.size) if t != ida_hexrays.mop_n else (t, mop.size, mop.valnum)
        match t:
            case ida_hexrays.mop_n:
                return key + (mop.nnn.value,)
            case ida_hexrays.mop_r:
                return key + (mop.r,)
            case ida_hexrays.mop_d:
                # Using the micro-instruction EA differentiates identical loads that
                # happen at different addresses, producing multiple leaves for the
                # same logical value.  Instead we rely on the operand text (dstr),
                # which is identical for identical expressions regardless of SSA
                # copy location.
                try:
                    return key + (mop.dstr(),)
                except Exception:
                    # As a last resort fall back to EA.
                    return key + (mop.d.ea if mop.d else idaapi.BADADDR,)
            case ida_hexrays.mop_S:
                return key + (mop.s.off,)
            case ida_hexrays.mop_v:
                return key + (mop.g,)
            case ida_hexrays.mop_l:
                return key + (mop.l.idx, mop.l.off)
            case ida_hexrays.mop_b:
                return key + (mop.b,)
            case ida_hexrays.mop_h:
                return key + (mop.helper,)
            case ida_hexrays.mop_str:
                return key + (mop.cstr,)
            case _:
                # For other types, including complex ones like mop_f, mop_a, etc.,
                # and mop_z, we fall back to the slower but safer dstr().
                # This is a deliberate trade-off for robustness.
                try:
                    return key + (mop.dstr(),)
                except Exception:
                    # As a last resort, if dstr() fails, use a placeholder.
                    # This can happen for uninitialized or unusual mop_t instances.
                    logger.warning(
                        "get_mop_key: Unsupported mop_t type: %s, returning placeholder",
                        mop_type_to_string(t),
                    )
                    return key + (f"unsupported_mop_t_{t}",)


    def mop_to_ast_internal(
        mop: ida_hexrays.mop_t, context: AstBuilderContext, root: bool = False
    ) -> AstBase | None:
        # Only log at root
        if root and logger.debug_on:
            logger.debug(
                "[mop_to_ast_internal] Processing root mop: %s",
                str(mop.dstr()) if hasattr(mop, "dstr") else str(mop),
            )

        # Early filter at root: only process if supported, with one exception:
        # If the root is an m_call that has no argument list (r is mop_z) we treat it
        # as transparent and attempt to build an AST from its destination operand.
        if root:
            if hasattr(mop, "d") and hasattr(mop.d, "opcode"):
                root_opcode = mop.d.opcode

                # Transparent helper call wrappers are now normalised by a
                # peephole pass (TransparentCallUnwrapRule).  No special handling
                # needed here anymore.

                if root_opcode not in MBA_RELATED_OPCODES and not is_rotate_helper_call(
                    mop.d
                ):
                    if logger.debug_on:
                        logger.debug(
                            "Skipping AST build for unsupported root opcode: %s",
                            opcode_to_string(root_opcode),
                        )
                    return None

        # 1. Create the unique, hashable key for the current mop.
        key = get_mop_key(mop)

        # 2. Thread-local deduplication: if we've already built an AST for *this*
        #    mop during the current recursive walk, return the existing instance to
        #    avoid exponential explosion.
        if key in context.mop_key_to_index:
            existing_index = context.mop_key_to_index[key]
            return context.unique_asts[existing_index]

        # Rotate helper calls (__ROL*/__ROR*) are now inlined into plain shift/or
        # instructions by RotateHelperInlineRule (peephole, MMAT_GLBOPT1).
        # No special handling required here.

        # Helper calls that evaluate to constants are now canonicalised by
        # ConstantCallResultFoldRule (peephole GLBOPT1).

        # NEW: Build AST nodes for MBA-related opcodes (binary or unary)
        if mop.t == ida_hexrays.mop_d and mop.d.opcode in MBA_RELATED_OPCODES:
            nb_ops = OPCODES_INFO[mop.d.opcode]["nb_operands"]

            # Gather children ASTs based on operand count
            left_ast = (
                mop_to_ast_internal(mop.d.l, context) if mop.d.l is not None else None
            )
            right_ast = (
                mop_to_ast_internal(mop.d.r, context)
                if (nb_ops >= 2 and mop.d.r is not None)
                else None
            )

            # Require at least the mandatory operands; if missing, fall back to leaf
            if left_ast is None:
                # Can't build meaningful node - fallback later to leaf
                if logger.debug_on:
                    logger.debug(
                        "[mop_to_ast_internal] Missing mandatory operand(s) for opcode %s, will treat as leaf",
                        opcode_to_string(mop.d.opcode),
                    )
            else:
                # Only use dst_ast if destination present (ternary ops like m_stx etc.)
                dst_ast = (
                    mop_to_ast_internal(mop.d.d, context) if mop.d.d is not None else None
                )
                tree = AstNode(mop.d.opcode, left_ast, right_ast, dst_ast)

                # Set dest_size robustly
                if hasattr(mop, "size") and mop.size:
                    tree.dest_size = mop.size
                elif hasattr(mop.d, "size") and mop.d.size:
                    tree.dest_size = mop.d.size
                elif mop.d.l is not None and hasattr(mop.d.l, "size"):
                    tree.dest_size = mop.d.l.size
                else:
                    tree.dest_size = None

                tree.mop = mop
                tree.ea = sanitize_ea(mop.d.ea)

                if logger.debug_on:
                    logger.debug(
                        "[mop_to_ast_internal] Created AstNode for opcode %s (ea=0x%X): %s",
                        opcode_to_string(mop.d.opcode),
                        mop.d.ea if hasattr(mop.d, "ea") else -1,
                        tree,
                    )
                new_index = len(context.unique_asts)
                tree.ast_index = new_index
                context.unique_asts.append(tree)
                context.mop_key_to_index[key] = new_index
                return tree

        # Special handling for mop_d that wraps an m_ldc as a constant leaf
        if (
            mop.t == ida_hexrays.mop_d
            and mop.d is not None
            and mop.d.opcode == ida_hexrays.m_ldc
        ):
            # Only treat it as constant if the *source* of the ldc is itself a
            # numeric constant.  Otherwise we ignore the ldc wrapper and fall
            # back to the generic leaf logic below.
            ldc_src = mop.d.l
            if ldc_src is not None and ldc_src.t == ida_hexrays.mop_n:
                const_val = int(ldc_src.nnn.value)
                const_size = ldc_src.size

                const_leaf = AstConstant(hex(const_val), const_val, const_size)
                # Clone numeric mop to detach from Hex-Rays internal storage
                cloned_mop = ida_hexrays.mop_t()
                cloned_mop.make_number(const_val, const_size)
                const_leaf.mop = cloned_mop
                const_leaf.dest_size = const_size

                new_index = len(context.unique_asts)
                const_leaf.ast_index = new_index
                context.unique_asts.append(const_leaf)
                context.mop_key_to_index[key] = new_index
                return const_leaf

        # Fallback for any unhandled mop: treat as a leaf.
        # This is for simple operands (registers, stack vars) or complex
        # instructions that are not part of our MBA analysis.
        if (
            mop.t != ida_hexrays.mop_d
            or (mop.d.opcode not in MBA_RELATED_OPCODES)
            or mop.d.l is None
            or mop.d.r is None
        ):
            tree: AstBase | None
            if mop.t == ida_hexrays.mop_n:
                const_val = int(mop.nnn.value)
                const_size = mop.size
                tree = AstConstant(hex(const_val), const_val, const_size)
                # Re-use a shared constant mop_t from the global cache to avoid the
                # overhead of allocating a fresh object for every identical literal.
                tree.mop = get_constant_mop(const_val, const_size)
                tree.dest_size = const_size  # detached copy
            # Typed-immediate wrappers (mop_f) are now normalised by the
            # TypedImmediateCanonicaliseRule peephole pass.  If we still see one
            # here it means it holds *no* literal value, therefore fall through to
            # generic leaf creation.
            elif mop.t == ida_hexrays.mop_f:
                tree = None
            else:
                tree = None

            # ------------------------------------------------------------------
            # If we still haven't built a node, create a generic AstLeaf now.  This
            # guarantees that *tree* is always defined even if new mop_t kinds are
            # introduced in future IDA versions.
            # ------------------------------------------------------------------
            if tree is None:
                tree = AstLeaf(format_mop_t(mop))
                if logger.debug_on:
                    logger.debug(
                        "[mop_to_ast_internal] Tree is NONE! Defaulting to AstLeaf for mop type %s dstr=%s",
                        mop_type_to_string(mop.t),
                        str(mop.dstr()) if hasattr(mop, "dstr") else str(mop),
                    )
                tree.dest_size = mop.size

            # For non-constant leaves we deliberately *do not* keep a reference
            # to the original mop_t object, because Hex-Rays may free or reuse
            # it after micro-optimisations, leading to use-after-free crashes.
            # Only constant leaves benefit from holding the numeric mop to
            # speed up further evaluations.
            if tree.is_constant():
                tree.mop = getattr(tree, "mop", None) or mop
            else:
                tree = AstLeaf(format_mop_t(mop))
                if logger.debug_on:
                    logger.debug(
                        "[mop_to_ast_internal] Fallback to AstLeaf for mop type %s dstr=%s",
                        mop_type_to_string(mop.t),
                        str(mop.dstr()) if hasattr(mop, "dstr") else str(mop),
                    )
                tree.dest_size = mop.size

            # Preserve previously assigned mop (e.g., inner numeric mop) unless
            # it is still unset.  This prevents clobbering the constant `mop_n`
            # we stored above with the wrapper operand, which would break
            # constant detection later in the pipeline.
            if getattr(tree, "mop", None) is None:
                tree.mop = mop
            dest_size = (
                mop.size
                if mop.t != ida_hexrays.mop_d
                else mop.d.d.size if mop.d.d is not None else mop.size
            )
            tree.dest_size = dest_size
            new_index = len(context.unique_asts)
            tree.ast_index = new_index
            context.unique_asts.append(tree)
            context.mop_key_to_index[key] = new_index
            return tree

        # If we reach here, we failed to build an AST. Log the full mop tree.
        logger.error("[mop_to_ast_internal] Could not build AST for mop. Dumping mop tree:")
        mop_tree(mop)
        return None


    def mop_to_ast(mop: ida_hexrays.mop_t) -> AstProxy | None:
        """
        Converts a mop_t to an AST node, with caching to avoid re-computation.

        Returns a deep copy of the cached AST to prevent side-effects from
        mutations by the caller.
        """

        # 1. Create a stable, hashable key from the mop_t object.
        cache_key = get_mop_key(mop)

        # 2. Global template cache: return a proxy if we already know the template
        if cache_key in MOP_TO_AST_CACHE:
            cached_template = MOP_TO_AST_CACHE[cache_key]
            if cached_template is None:
                return None  # Previously determined unconvertible.
            return AstProxy(cached_template)

        builder_context = AstBuilderContext()
        # Start the optimized recursive build.

        if not (mop_ast := mop_to_ast_internal(mop, builder_context, root=True)):
            # Cache the failure to avoid re-computing it.
            MOP_TO_AST_CACHE[cache_key] = None
            return None

        # This mutates the mop_ast object, populating its sub_ast_info.
        # We do this ONCE before caching the "template" object, then we
        # freeze the object to prevent mutations.
        mop_ast.compute_sub_ast()
        mop_ast.freeze()

        # 4. Store the newly computed "template" object in the cache.
        MOP_TO_AST_CACHE[cache_key] = mop_ast

        # 5. Return a proxy to the caller for safety.
        return AstProxy(mop_ast)


    def _py_slow_minsn_to_ast(instruction: ida_hexrays.minsn_t) -> AstProxy | None:
        try:
            # Early filter: forbidden opcodes
            if instruction.opcode in MINSN_TO_AST_FORBIDDEN_OPCODES:
                if logger.debug_on:
                    logger.debug(
                        "Skipping AST build for forbidden opcode: %s @ 0x%x %s",
                        opcode_to_string(instruction.opcode),
                        instruction.ea,
                        (
                            "({0})".format(instruction.dstr())
                            if instruction.opcode != ida_hexrays.m_jtbl
                            else ""
                        ),
                    )
                return None

            # Early filter: unsupported opcodes (not in MBA_RELATED_OPCODES)
            # Allow rotate helper calls ("__ROL*" / "__ROR*") even though m_call
            # is normally filtered out - they can be constant-folded later.
            if instruction.opcode not in MBA_RELATED_OPCODES and not is_rotate_helper_call(
                instruction
            ):
                if logger.debug_on:
                    logger.debug(
                        "Skipping AST build for unsupported opcode: %s @ 0x%x %s",
                        opcode_to_string(instruction.opcode),
                        instruction.ea,
                        (
                            "({0})".format(instruction.dstr())
                            if instruction.opcode != ida_hexrays.m_jtbl
                            else ""
                        ),
                    )
                return None

            # Constant-returning helper calls are folded to m_ldc by the peephole
            # pass ConstantCallResultFoldRule.  No need for AST special case.

            # Transparent-call shortcut: no args, computation stored in destination mop_d
            if (
                instruction.opcode == ida_hexrays.m_call
                and (instruction.r is None or instruction.r.t == ida_hexrays.mop_z)
                and instruction.d is not None
                and instruction.d.t == ida_hexrays.mop_d
            ):
                if logger.debug_on:
                    logger.debug(
                        "[minsn_to_ast] Unwrapping call with empty args; using destination expression for AST",
                    )
                dest_ast = mop_to_ast(instruction.d)
                if dest_ast is not None:
                    return dest_ast

            ins_mop = ida_hexrays.mop_t()
            ins_mop.create_from_insn(instruction)

            # if instruction.opcode == ida_hexrays.m_mov:
            #     tmp = AstNode(ida_hexrays.m_mov, mop_to_ast(ins_mop))
            #     tmp.mop = ins_mop
            #     tmp.dest_size = instruction.d.size
            #     tmp.ea = instruction.ea
            #     tmp.dst_mop = instruction.d
            #     return tmp

            tmp = mop_to_ast(ins_mop)
            if tmp is None:
                if logger.debug_on:
                    logger.debug(
                        "Skipping AST build for unsupported or nop instruction: %s @ 0x%x %s",
                        opcode_to_string(instruction.opcode),
                        instruction.ea,
                        (
                            "({0})".format(instruction.dstr())
                            if instruction.opcode != ida_hexrays.m_jtbl
                            else ""
                        ),
                    )
            else:
                tmp.dst_mop = instruction.d
            return tmp
        except RuntimeError as e:
            logger.error(
                "Error while transforming instruction %s: %s",
                format_minsn_t(instruction),
                e,
            )


    # Public, unified entrypoint that callers can use instead of reaching into
    # the Cython module directly. If `use_cython` is True and the extension is
    # available, we delegate to `_cy_fast_minsn_to_ast`; otherwise we call the
    # pure-Python builder (defined below or elsewhere in this module).
    def minsn_to_ast(ins: ida_hexrays.minsn_t) -> typing.Any | None:
        # Fast path
        if use_cython and _CYTHON_FAST_AST_OK:
            return _cy_fast_minsn_to_ast(
                ins,
                MOP_TO_AST_CACHE,
                AstProxy,
                AstNode,
                AstLeaf,
                AstConstant,
                get_constant_mop,
                MBA_RELATED_OPCODES,
            )
        # Slow path
        return _py_slow_minsn_to_ast(ins)


    # Side-by-side checker to compare the two implementations on the same input.
    # Returns (py_ast, cy_ast). Caller can diff patterns, shapes, etc.
    def compare_cython_vs_python(
        ins: ida_hexrays.minsn_t,
    ) -> tuple[typing.Any | None, typing.Any | None]:
        py_ast = _py_slow_minsn_to_ast(ins)
        cy_ast = None
        if _CYTHON_FAST_AST_OK:
            cy_ast = _cy_fast_minsn_to_ast(
                ins,
                MOP_TO_AST_CACHE,
                AstProxy,
                AstNode,
                AstLeaf,
                AstConstant,
                get_constant_mop,
                MBA_RELATED_OPCODES,
            )
        return py_ast, cy_ast



Here's the Cython code that was ported from the Python code. I added a flag at the top to enable/disable the Cython code. By default, the Cython code is enabled. If you want to see the profile results for the Cython code, you can disable it by running this command in the `Python` console for IDA: `from d810.expr import ast as expr_ast; expr_ast.set_use_cython(False); print(expr_ast.use_cython)` which should print `False`. Now, re-run the decompilation and you should see the profile results for the original Python code.

.. code-block:: python
    # distutils: language = c++
    # cython: language_level=3, embedsignature=True
    # distutils: define_macros=__EA64__=1

    # Import Python modules and types needed
    import idaapi
    import ida_hexrays
    # from ida_hexrays cimport mop_t, mop_n, mop_r, mop_d, mop_S, mop_v, mop_l, mop_b, mop_h, mop_str

    from d810.conf.loggers import getLogger # Use project logger
    from d810.hexrays.hexrays_formatters import (
        format_mop_t,
        opcode_to_string,
        sanitize_ea,
    )
    from d810.hexrays.hexrays_helpers import (
        MBA_RELATED_OPCODES,
        OPCODES_INFO,
        is_rotate_helper_call,
    )

    # to avoid circular imports
    # from d810.expr.ast import AstNode, AstLeaf, AstConstant, AstProxy, get_mop_key, get_constant_mop
    # Import Ast classes - they remain Python objects for now
    # Assuming they are available in the Python path or declared in a .pxd

    # Import helper for mop tree dumping if needed (might require special handling)
    # from d810.hexrays.hexrays_formatters import mop_tree

    # Use the project's getLogger
    logger = getLogger(__name__)

    # --- Simplified AstBuilderContext for Phase 1 ---
    # Using Python objects (list, dict) for simplicity in the first pass.
    cdef class AstBuilderContext:
        cdef public list unique_asts
        cdef public dict mop_key_to_index

        def __cinit__(self):
            self.unique_asts = []
            self.mop_key_to_index = {}


    cdef str mop_type_to_string(int t):
        """Helper to convert mop type to string for logging (simplified)"""
        return f"mop_{t}"


    def get_mop_key_cy(mop):
        """
        Generates a fast, hashable key from a mop_t's essential attributes.
        Cython version that takes Python mop_t for compatibility.
        """
        cdef int t = mop.t
        
        # Build base key - same logic as Python
        key = (t, mop.size) if t != ida_hexrays.mop_n else (t, mop.size, mop.valnum)
        
        if t == ida_hexrays.mop_n:
            return key + (mop.nnn.value,)
        elif t == ida_hexrays.mop_r:
            return key + (mop.r,)
        elif t == ida_hexrays.mop_d:
            try:
                return key + (mop.dstr(),)
            except:
                if mop.d:
                    return key + (mop.d.ea,)
                else:
                    return key + (idaapi.BADADDR,)
        elif t == ida_hexrays.mop_S:
            return key + (mop.s.off,)
        elif t == ida_hexrays.mop_v:
            return key + (mop.g,)
        elif t == ida_hexrays.mop_l:
            return key + (mop.l.idx, mop.l.off)
        elif t == ida_hexrays.mop_b:
            return key + (mop.b,)
        elif t == ida_hexrays.mop_h:
            return key + (mop.helper,)
        elif t == ida_hexrays.mop_str:
            return key + (mop.cstr,)
        else:
            try:
                return key + (mop.dstr(),)
            except:
                return key + (f"unsupported_mop_t_{t}",)

    # Port mop_to_ast_internal as a cdef function
    # Use 'object' for mop initially for compatibility with SWIG wrapper
    cdef object mop_to_ast_internal_cy(object mop, AstBuilderContext bldr_ctx, object ctx, bint root=False):
        # Use project-specific debug flag
        if root and logger.debug_on:
            logger.debug(
                "[mop_to_ast_internal] Processing root mop: %s",
                str(mop.dstr()) if hasattr(mop, "dstr") else str(mop),
            )

        # Early filter at root
        if root:
            if hasattr(mop, "d") and hasattr(mop.d, "opcode"):
                root_opcode = mop.d.opcode
                # Check against MBA_RELATED_OPCODES and rotate helpers
                if root_opcode not in MBA_RELATED_OPCODES and not is_rotate_helper_call(mop.d):
                    if logger.debug_on:
                        logger.debug(
                            "Skipping AST build for unsupported root opcode: %s",
                            opcode_to_string(root_opcode),
                        )
                    return None

        # 1. Create the unique, hashable key for the current mop.
        # Call the Python get_mop_key function
        key = get_mop_key_cy(mop)

        # 2. Thread-local deduplication
        if key in bldr_ctx.mop_key_to_index:
            existing_index = bldr_ctx.mop_key_to_index[key]
            return bldr_ctx.unique_asts[existing_index]

        # NEW: Build AST nodes for MBA-related opcodes
        if mop.t == ida_hexrays.mop_d and mop.d.opcode in MBA_RELATED_OPCODES:
            nb_ops = OPCODES_INFO[mop.d.opcode]["nb_operands"]
            # Gather children ASTs based on operand count
            # Recursive calls to the Cython version
            left_ast = mop_to_ast_internal_cy(mop.d.l, bldr_ctx, ctx) if mop.d.l is not None else None
            right_ast = (
                mop_to_ast_internal_cy(mop.d.r, bldr_ctx, ctx)
                if (nb_ops >= 2 and mop.d.r is not None)
                else None
            )

            # Require at least the mandatory operands
            if left_ast is None:
                # Can't build meaningful node - fallback later to leaf
                if logger.debug_on:
                    logger.debug(
                        "[mop_to_ast_internal] Missing mandatory operand(s) for opcode %s, will treat as leaf",
                        opcode_to_string(mop.d.opcode),
                    )
            else:
                # Only use dst_ast if destination present
                dst_ast = mop_to_ast_internal_cy(mop.d.d, bldr_ctx, ctx) if mop.d.d is not None else None

                # Create AstNode (Python object)
                tree = ctx["ast_node_py"](mop.d.opcode, left_ast, right_ast, dst_ast)

                # Set dest_size robustly
                if hasattr(mop, "size") and mop.size:
                    tree.dest_size = mop.size
                elif hasattr(mop.d, "size") and mop.d.size:
                    tree.dest_size = mop.d.size
                elif mop.d.l is not None and hasattr(mop.d.l, "size"):
                    tree.dest_size = mop.d.l.size
                else:
                    tree.dest_size = None

                tree.mop = mop
                tree.ea = sanitize_ea(mop.d.ea)

                if logger.debug_on:
                    logger.debug(
                        "[mop_to_ast_internal] Created AstNode for opcode %s (ea=0x%X): %s",
                        opcode_to_string(mop.d.opcode),
                        mop.d.ea if hasattr(mop.d, "ea") else -1,
                        tree,
                    )

                new_index = len(bldr_ctx.unique_asts)
                tree.ast_index = new_index
                bldr_ctx.unique_asts.append(tree)
                bldr_ctx.mop_key_to_index[key] = new_index
                return tree

        # Special handling for mop_d that wraps an m_ldc as a constant leaf
        if (
            mop.t == ida_hexrays.mop_d
            and mop.d is not None
            and mop.d.opcode == ida_hexrays.m_ldc
        ):
            ldc_src = mop.d.l
            if ldc_src is not None and ldc_src.t == ida_hexrays.mop_n:
                const_val = int(ldc_src.nnn.value)
                const_size = ldc_src.size
                const_leaf = ctx["ast_constant_py"](hex(const_val), const_val, const_size)

                # Use get_constant_mop (Python function) - Reuse shared mop
                const_leaf.mop = ctx["get_constant_mop_py"](const_val, const_size)
                const_leaf.dest_size = const_size

                new_index = len(bldr_ctx.unique_asts)
                const_leaf.ast_index = new_index
                bldr_ctx.unique_asts.append(const_leaf)
                bldr_ctx.mop_key_to_index[key] = new_index
                return const_leaf

        # Fallback for any unhandled mop: treat as a leaf.
        tree = None
        if mop.t == ida_hexrays.mop_n:
            const_val = int(mop.nnn.value)
            const_size = mop.size
            tree = ctx["ast_constant_py"](hex(const_val), const_val, const_size)
            # Re-use a shared constant mop_t
            tree.mop = ctx["get_constant_mop_py"](const_val, const_size)
            tree.dest_size = const_size

        elif mop.t == ida_hexrays.mop_f:
            tree = None
        else:
            tree = None

        # ------------------------------------------------------------------
        # If we still haven't built a node, create a generic AstLeaf now.
        # ------------------------------------------------------------------
        if tree is None:
            tree = ctx["ast_leaf_py"](format_mop_t(mop))
            if logger.debug_on:
                logger.debug(
                    "[mop_to_ast_internal] Tree is NONE! Defaulting to AstLeaf for mop type %s dstr=%s",
                    mop_type_to_string(mop.t),
                    str(mop.dstr()) if hasattr(mop, "dstr") else str(mop),
                )
            tree.dest_size = mop.size

        # For non-constant leaves, create a new AstLeaf (as per original logic)
        # Note: The original Python logic seems to have a duplicate/overwriting section here.
        # The ported version reflects the final outcome of that logic.
        if not tree.is_constant():
            tree = ctx["ast_leaf_py"](format_mop_t(mop)) # Overwrite with generic leaf
            if logger.debug_on:
                logger.debug(
                    "[mop_to_ast_internal] Fallback to AstLeaf for mop type %s dstr=%s",
                    mop_type_to_string(mop.t),
                    str(mop.dstr()) if hasattr(mop, "dstr") else str(mop),
                )
            tree.dest_size = mop.size

        # Preserve previously assigned mop for constants, assign mop for others
        if getattr(tree, "mop", None) is None:
            tree.mop = mop

        # Determine dest_size (mirroring original logic's attempt)
        dest_size = (
            mop.size
            if mop.t != ida_hexrays.mop_d
            else (mop.d.d.size if mop.d.d is not None else mop.size)
        )
        tree.dest_size = dest_size

        new_index = len(bldr_ctx.unique_asts)
        tree.ast_index = new_index
        bldr_ctx.unique_asts.append(tree)
        bldr_ctx.mop_key_to_index[key] = new_index
        return tree

        # If we reach here, we failed to build an AST.
        # logger.error("[mop_to_ast_internal] Could not build AST for mop. Dumping mop tree (not implemented in Cython port yet)")
        # mop_tree(mop) # Assuming mop_tree is a Python function, might need special handling or commenting out for now
        # return None # Implicit return None at end of function


    # Port mop_to_ast as a cdef function
    cdef object mop_to_ast_cy(object mop, object ctx):
        """
        Converts a mop_t to an AST node, with caching to avoid re-computation.
        Returns a deep copy of the cached AST to prevent side-effects from
        mutations by the caller.
        """
        # 1. Create a stable, hashable key from the mop_t object.
        # Call the Python get_mop_key function
        cache_key = get_mop_key_cy(mop)

        # 2. Global template cache: return a proxy if we already know the template
        # Access the global Python MOP_TO_AST_CACHE dict
        if cache_key in ctx["mop_to_ast_cache_py"]:
            cached_template = ctx["mop_to_ast_cache_py"][cache_key]
            if cached_template is None:
                return None  # Previously determined unconvertible.
            # Return AstProxy (Python object)
            return ctx["ast_proxy_py"](cached_template)

        # Create builder context
        builder_context = AstBuilderContext()

        # Start the optimized recursive build.
        # Call the Cython version
        mop_ast = mop_to_ast_internal_cy(mop, builder_context, ctx, root=True)
        if not mop_ast:
            # Cache the failure to avoid re-computing it.
            ctx["mop_to_ast_cache_py"][cache_key] = None
            return None

        # This mutates the mop_ast object, populating its sub_ast_info.
        mop_ast.compute_sub_ast()
        mop_ast.freeze()

        # 4. Store the newly computed "template" object in the cache.
        ctx["mop_to_ast_cache_py"][cache_key] = mop_ast

        # 5. Return a proxy to the caller for safety.
        return ctx["ast_proxy_py"](mop_ast)


    # Public wrapper def function to be called from Python
    def cython_mop_to_ast(object mop, object ctx):
        """Public entry point for the Cython mop_to_ast implementation."""
        return mop_to_ast_cy(mop, ctx)

    def fast_minsn_to_ast(
        object ins_py,
        object mop_to_ast_cache_py, # Not used directly, relies on imported MOP_TO_AST_CACHE
        object ast_proxy_py,        # Not used directly, relies on imported AstProxy
        object ast_node_py,         # Not used directly, relies on imported AstNode
        object ast_leaf_py,         # Not used directly, relies on imported AstLeaf
        object ast_constant_py,     # Not used directly, relies on imported AstConstant
        object get_constant_mop_py, # Not used directly, relies on imported get_constant_mop
        object mba_related_opcodes_py, # Not used directly, relies on imported MBA_RELATED_OPCODES
    ):
        """
        Public entry point matching the signature expected by the original ast.py fast path.
        ins_py: ida_hexrays.minsn_t
        The rest of the arguments are passed for compatibility but the Cython version uses
        the imported Python objects directly.
        """
        # Create a mop_t from the instruction, mirroring the Python slow path logic
        cdef object ins_mop = ida_hexrays.mop_t()
        ins_mop.create_from_insn(ins_py)
        kwargs = {
            "mop_to_ast_cache_py": mop_to_ast_cache_py,
            "ast_proxy_py": ast_proxy_py,
            "ast_node_py": ast_node_py,
            "ast_leaf_py": ast_leaf_py,
            "ast_constant_py": ast_constant_py,
            "get_constant_mop_py": get_constant_mop_py,
            "mba_related_opcodes_py": mba_related_opcodes_py,
        }
        # Call the core Cython mop_to_ast function
        cdef object result = mop_to_ast_cy(ins_mop, kwargs)

        # The imported AstProxy is used inside mop_to_ast_cy, so the result is already an AstProxy
        # or None. No further wrapping needed if the internal logic is consistent.
        return result
		
Results
=======

The difference in performance is pretty stark. The Cython code is about 4.6x faster than the Python code.

Major Wins
----------

1. **Functionality is working** - both produced the same output
2. **Cache hits are recovering** - We went from ~2k hits (broken) back to ~2k hits (healthy).
3. **Overall performance improved** - Total time dropped from **2.979s → 0.647s** (4.6x speedup!).

Detailed Comparison
-------------------

**Cython Version (A) vs Python Version (B):**

::

    Total Time: 0.647s (Cython) vs 2.979s (Python) = 4.6x faster!

**Cache Performance:**

- Cython: 1988 hits
- Python: 1994 hits

  → *Essentially identical* – the cache key issue is **fixed**.

**AST Generation Hotspots:**

- Both versions spend most time in the same places (pattern matching, Z3 optimization).
- The ``minsn_to_ast`` path is now much faster in Cython.

What This Means
---------------

1. **Correctness**: The Cython port is functionally equivalent to Python.
2. **Performance**: We achieved the dramatic speedup we wanted (~4.6x).
3. **Stability**: No more crashes on problematic instructions like ``stx``.
4. **Cache Integrity**: Cache hits are back to normal levels.

Logging Overhead
----------------

Notice the significant time spent in logging:

::

    D810Logger.debug → FileHandler.format → D810Formatter.format

Consider reducing debug logging in production builds.

Summary
-------

+------------+---------+---------+----------+
| Metric     | Python  | Cython  | Speedup  |
+============+=========+=========+==========+
| Total Time | 2.979s  | 0.647s  | **4.6x** |
+------------+---------+---------+----------+
| Cache Hits | 1994    | 1988    | ~1:1     |
+------------+---------+---------+----------+

This should make a **huge difference** in your decompilation performance, especially for large binaries where AST generation was the bottleneck.

.. """XZCython

.. Cython:
..   -> interface: *.pxd           # not allows pure python `def`s
..   -> wrapper, *.pyx  &  *.py    # same name `interface` will be automatically searched
.. After compiled:
..   -> linux: *.so
..   -> windows: *.pyd
.. Note:
..     `wrapper` should be different name with `interface`,
..     otherwise, signatures inside wrapper will be used instead

.. Compiler directives:
..     https://cython.readthedocs.io/en/latest/src/userguide/source_files_and_compilation.html#compiler-directives

.. Some important directives:
..     # distutils: language = C++
..     # distutils: libraries = lib1  lib2
..     # distutils: include_dirs = dir1  dir2
..     # distutils: sources = s.c  s.cpp
..     # cython: language_level = 3        # python version, no need
..     #link: https://cython.readthedocs.io/en/latest/src/userguide/source_files_and_compilation.html

.. Decorators:
..     @cython.exceptval(check=True)
..     @cython.cfunc       # create `cdef` function
..     @cython.cclass      # create `cdef class`
..     @cython.ccall       # create `cpdef` function
..     @cython.locals      # local variables
..     @cython.inline      # equivalent with C inline
..     @cython.returns
..     @cython.profile
..     @cython.declare

.. Keywords:
..     `cdef`      : used for internal C functions
..     `cpdef`     : visible to Python

..     cdef class cls
..     cdef [public|inline] [int|str|bint] var
..     cdef [struct|union|enum] block

..     DEF key value       # work like macros in compiling time


.. Compile Process:
..     1) generate C/C++ source codes:
..         cython source.pyx   # new file: `source.c` or `source.cpp`
    
..     2) compile:
..         gcc -pthread -B /home/xiang/Applications/miniconda3/compiler_compat \
..             -Wsign-compare -g -fwrapv -O3 -Wall -fPIC       \
..             -I/home/xiang/Applications/miniconda3/include/python3.8 \
..             -I/all/my/includes \
..             -c source.cpp       -o source.o
..         g++ -pthread -B /home/xiang/Applications/miniconda3/compiler_compat -shared \
..             -L/home/xiang/Applications/miniconda3/lib       \
..             -Wl,-rpath=/home/xiang/Applications/miniconda3/lib      \
..             -I/all/my/includes \
..             allmyobjs.o         -o final.so
.. """


.. from setuptools import Extension, setup
.. from Cython.Build import cythonize

.. setup(
..     name='obj',
..     ext_modules = cythonize([Extension("queue", ["queue.pyx"])])
.. )


.. """Files

.. # interface file: cqueue.pxd
.. # (selectively copy-and-paste of header file)
.. cdef extern from "queue.h":
..     ctypedef struct Queue:
..         pass
..     Queue* queue_new()


.. # wrapper file: queue.pyx
.. # (following compiler directives should be defined)
.. # distutils: sources = path/to/source/queue.c
.. # distutils: include_dirs = path/to/source/
.. cimport cqueue
.. cdef func(int a):
..     pass
.. cdef class Temp:
..     def __cinit__(self):
..         pass
..     def __dealloc__(self):
..         pass
.. """


It's been roughly two years since Cython released version 3.0.0, and it's been a while since I've dabbled with it. I've been using IDA Pro for a while now, and I've noticed that it's not the fastest. I've also noticed that the internet is littered with articles about how to make IDA Pro faster. I've been using IDA Pro for a while now, and I've noticed that it's not the fastest. I've also noticed that the internet is littered with articles about how to make IDA Pro faster.
	
I've been using IDA Pro for a while now, and I've noticed that it's not the fastest. I've also noticed that the internet is littered with articles about how to make IDA Pro faster.





I get that if I adorn my python3 with types the right way, cython can uplift C betterer, but if I don't adorn my python3 and only use core imports (no pip) do I get any benefit?
I have some humongous (for me) dict lookups I am doing on strings, counting in ints, and if I could 2x or 3x faster without having to recode I'd love it. The Cython web is directed at people willing to recode, I am ultimately willing but I wish there was some low hanging fruit evidence: is this even plausibly going to get faster or is dict() walk cost just "it is what it is" ?

Oddly, it looks like across pickle dump/load I get some improvement. Does pickle restoring consume less memory than raw-made?


	
gyrovagueGeist on July 19, 2023 | parent | next [–]

You will ~likely get some improvement by directly putting your python code in a .pyx file and compiling it (without using any cdef functions). In most cases it will be as if you were calling the Python C API directly in a compiled C file. In my experience, the biggest difference will be a reduction in the function call overhead so it is better for tight loops.

`Nose`_ is a fantastic testing framework. What surprises me though, is
that there's no out of the box plugin to time tests to see which tests
are the slowest, and most likely, problematic. After all, unit tests are
supposed to be wicked fast. I googled, but nothing really came up except
an `insightful google-groups post`_.

I figured, what the hey, might as well just write a simple nose plugin
to time the tests. I modeled it slightly off the `xunit nose plugin`_.
With the xunit plugin as a guiding example, I thought it was pretty
trivial to write a nose plugin, definitely a testament to the great
design chosen by nose.

.. gist:: 848183 nose-timetests.py

Something cool about nose was that you don't have to install a plugin
package-wide using setuptools, but you can actually `just dynamically
add it during run-time`_. All you have to do is:

.. code-block:: python

  import nose

  from yourplugin import YourPlugin

  if __name__ == '__main__':
      nose.main(addplugins=[YourPlugin()])


This way, you can just execute your tests as normal, like so:

.. code-block:: bash

  python nose-testtimers.py --with-test-timer -sv --debug=sqlalchemy.engine


and you get a nice little output of test times :)

.. _Nose: https://nose.readthedocs.io/en/latest/
.. _insightful google-groups post: http://groups.google.com/group/nose-users/browse_thread/thread/ad51415d14bda06e
.. _xunit nose plugin: https://github.com/nose-devs/nose/blob/master/nose/plugins/xunit.py
.. _just dynamically add it during run-time: https://nose.readthedocs.io/en/latest/plugins/writing.html#registering-a-plugin-without-setuptools
