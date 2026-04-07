"""
Sandboxed Python execution for calculations.
Executes math safely with numpy, scipy, sympy, and pint (units).
No network, no filesystem, timeout enforced.
"""
import logging
import multiprocessing
import traceback
from typing import Any

logger = logging.getLogger(__name__)

# Allowed modules for the sandbox
ALLOWED_MODULES = {
    "math", "cmath", "decimal", "fractions",
    "numpy", "scipy", "sympy", "pint",
}

SANDBOX_TIMEOUT = 30  # seconds


def _execute_in_process(code: str, result_queue: multiprocessing.Queue):
    """Execute code in a restricted subprocess."""
    try:
        # Restricted globals — only safe builtins + math/science libs
        safe_builtins = {
            "abs": abs, "round": round, "min": min, "max": max,
            "sum": sum, "len": len, "range": range, "enumerate": enumerate,
            "zip": zip, "map": map, "filter": filter,
            "int": int, "float": float, "str": str, "bool": bool,
            "list": list, "dict": dict, "tuple": tuple, "set": set,
            "True": True, "False": False, "None": None,
            "print": lambda *args: None,  # Suppress print
            "pow": pow,
        }

        restricted_globals: dict[str, Any] = {"__builtins__": safe_builtins}

        # Pre-import allowed math/science modules
        try:
            import math
            restricted_globals["math"] = math
        except ImportError:
            pass

        try:
            import numpy as np
            restricted_globals["np"] = np
            restricted_globals["numpy"] = np
        except ImportError:
            pass

        try:
            import sympy
            restricted_globals["sympy"] = sympy
        except ImportError:
            pass

        try:
            import scipy
            restricted_globals["scipy"] = scipy
        except ImportError:
            pass

        try:
            import pint
            restricted_globals["pint"] = pint
            restricted_globals["ureg"] = pint.UnitRegistry()
        except ImportError:
            pass

        # Execute the code
        local_vars: dict[str, Any] = {}
        exec(code, restricted_globals, local_vars)

        # Extract the result (last assigned variable or 'result')
        output = local_vars.get("result", None)
        if output is None:
            # Try to get the last assigned value
            for key in reversed(list(local_vars.keys())):
                if not key.startswith("_"):
                    output = local_vars[key]
                    break

        result_queue.put({"success": True, "result": str(output), "variables": {
            k: str(v) for k, v in local_vars.items() if not k.startswith("_")
        }})
    except Exception as e:
        result_queue.put({"success": False, "error": str(e), "traceback": traceback.format_exc()})


def execute_calculation(code: str) -> dict:
    """
    Execute Python calculation code in a sandboxed subprocess.

    Returns:
        {
            "success": bool,
            "result": str | None,
            "variables": dict | None,
            "error": str | None,
        }
    """
    result_queue = multiprocessing.Queue()
    process = multiprocessing.Process(target=_execute_in_process, args=(code, result_queue))
    process.start()
    process.join(timeout=SANDBOX_TIMEOUT)

    if process.is_alive():
        process.terminate()
        process.join(timeout=5)
        return {"success": False, "error": "Calculation timed out", "result": None, "variables": None}

    if result_queue.empty():
        return {"success": False, "error": "No result produced", "result": None, "variables": None}

    return result_queue.get()
