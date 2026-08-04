"""Flet desktop packager entry point."""

from hdu_sniper.desktop import main
from hdu_sniper.diagnostics import desktop_self_check
from hdu_sniper.runtime import get_app


if __name__ == "__main__":
    main(application=get_app(), self_check=desktop_self_check)
