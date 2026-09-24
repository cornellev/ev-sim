"""Saved-environment camera clip export."""

__all__ = ["ClipError", "check_clip", "export_clip"]


def __getattr__(name):
    if name == "ClipError":
        from cev_sim.clip.contract import ClipError
        return ClipError
    if name == "check_clip":
        from cev_sim.clip.check import check_clip
        return check_clip
    if name == "export_clip":
        from cev_sim.clip.export import export_clip
        return export_clip
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
