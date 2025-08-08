# mahmoudimus.com

The code that runs my weblog, powered by [Pelican](https://getpelican.com/), a static site generator written in Python.

## Installation

This project uses modern Python packaging with `pyproject.toml`. To install:

```bash
# Create and activate a virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install the project in development mode
pip install -e .
```

## Usage

The blog comes with several commands:

```bash
# Build the site
blog-build

# Serve the site locally
blog-serve

# Publish the site
blog-publish
```

Alternatively, you can use the Makefile:

```bash
# Build the site
make html

# Serve the site locally
make serve

# Publish the site
make publish
```

## Development

To install development dependencies:

```bash
pip install -e ".[dev]"
```

## License

MIT