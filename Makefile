PY?=pyenv exec python
PELICANOPTS=

OUTPUTDIR=$(CURDIR)/output
BUILD=$(PY) -m src.cli


DEBUG ?= 0
ifeq ($(DEBUG), 1)
	PELICANOPTS += -D
endif

RELATIVE ?= 0
ifeq ($(RELATIVE), 1)
	PELICANOPTS += --relative-urls
endif

help:
	@echo 'Makefile for a pelican Web site                                           '
	@echo '                                                                          '
	@echo 'Usage:                                                                    '
	@echo '   make html                           (re)generate the web site          '
	@echo '   make clean                          remove the generated files         '
	@echo '   make regenerate                     regenerate files upon modification '
	@echo '   make publish                        generate using production settings '
	@echo '   make serve [PORT=8000]              serve site at http://localhost:8000'
	@echo '   make serve-global [SERVER=0.0.0.0]  serve (as root) to $(SERVER):80    '
	@echo '   make devserver [PORT=8000]          serve and regenerate together      '
	@echo '   make ssh_upload                     upload the web site via SSH        '
	@echo '   make rsync_upload                   upload the web site via rsync+ssh  '
	@echo '                                                                          '
	@echo 'Set the DEBUG variable to 1 to enable debugging, e.g. make DEBUG=1 html   '
	@echo 'Set the RELATIVE variable to 1 to enable relative urls                    '
	@echo '                                                                          '

html:
	$(BUILD) -o $(OUTPUTDIR) $(PELICANOPTS)

clean:
	[ ! -d $(OUTPUTDIR) ] || rm -rf $(OUTPUTDIR)

regenerate:
	$(BUILD) -r -o $(OUTPUTDIR) $(PELICANOPTS)

serve:
ifdef PORT
	$(BUILD) -l -o $(OUTPUTDIR) $(PELICANOPTS) -p $(PORT)
else
	$(BUILD) -l -o $(OUTPUTDIR) $(PELICANOPTS)
endif

serve-global:
ifdef SERVER
	$(BUILD) -l -o $(OUTPUTDIR) $(PELICANOPTS) -p $(PORT) -b $(SERVER)
else
	$(BUILD) -l -o $(OUTPUTDIR) $(PELICANOPTS) -p $(PORT) -b 0.0.0.0
endif


devserver:
ifdef PORT
	$(BUILD) -lr -o $(OUTPUTDIR) $(PELICANOPTS) -p $(PORT)
else
	$(BUILD) -lr -o $(OUTPUTDIR) $(PELICANOPTS)
endif

publish:
	SITEURL=https://mahmoudimus.com $(BUILD) -o $(OUTPUTDIR) $(PELICANOPTS)


.PHONY: html help clean regenerate serve serve-global devserver stopserver publish
