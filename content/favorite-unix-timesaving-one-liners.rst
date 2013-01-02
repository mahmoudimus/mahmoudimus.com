# recursive diff of a directory on another machine
for file in $(find remote_directory); do diff ${file} <(ssh remote_host "cat ${file}"); done


find `pwd` -name "release*" | xargs -i /bin/bash -lc "echo -n {} :: Â ; readlink {}" | grep -iP NOVA_2_5_26_EBF\(36\|48\|55\|70\|72\|79\)

xargs, etc..
