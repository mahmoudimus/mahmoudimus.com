# Get customers to integrate into VGS faster

How do we route customer traffic locally and have them ship the traffic to us?

https://security.stackexchange.com/questions/33374/whats-an-easy-way-to-perform-a-man-in-the-middle-attack-on-ssl/33376#33376

## Ngrok



## Serveo


## tshark

I found a working solution. It doesn't work on a live interface and requires to first save a pcap file but it is the best I managed to do with tshark.

Step1 (capture network trafic):
tshark -i eth0 -f "port 9088" -w capture.pcap
Step2 (list captured tcp streams):
tshark -r capture.pcap -T fields -e tcp.stream | sort -u

Step3 (dump the content of one particular tcp stream):
tshark -nr capture.pcap -q -d tcp.port==9088,http -z follow,http,ascii,_your_stream_number

Noice the "-d tcp.port==9088,http" option to force http decoding on this port as in my case it is a socks5 proxy running on that port.

Most importantly "-z follow,http,ascii,_your_stream_number" where the "follow,http" feature decodes gziped http body content and is undocumented and only available from version 2.2.0 of wireshark/tshark.

tshark -Y http.request.method==POST -Tfields -e http.file_data
