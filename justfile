set shell := ["bash", "-euo", "pipefail", "-c"]

default: check

shell:
    devenv shell

doctor:
    devenv shell ciclo-doctor

hooks:
    devenv shell ciclo-hooks-check

python:
    devenv shell ciclo-python-check

typescript:
    devenv shell ciclo-typescript-check

quint:
    devenv shell ciclo-quint

check:
    devenv shell ciclo-check
