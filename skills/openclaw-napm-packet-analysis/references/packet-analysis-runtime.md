# Packet Analysis Runtime

This skill uses host tools instead of custom protocol parsing.

Required tool for analysis:

```text
tshark
```

Optional metadata helper:

```text
capinfos
```

Typical calls:

```bash
tshark -r capture.pcap -q -z io,phs
tshark -r capture.pcap -q -z endpoints,ip
tshark -r capture.pcap -q -z conv,ip
tshark -r capture.pcap -Y dns.qry.name -T fields -e dns.qry.name
tshark -r capture.pcap -Y http -T fields -e http.host -e http.request.uri -e http.response.code
tshark -r capture.pcap -Y tls.handshake.extensions_server_name -T fields -e tls.handshake.extensions_server_name
```

Keep analyzer calls bounded:

- pass file paths as argv values, not shell strings;
- enforce timeout;
- summarize output;
- do not print packet payloads by default.

`capinfos` is useful for packet count, file format, and capture duration, but it is not a hard dependency. If `capinfos` is missing, continue with `tshark` and report the missing metadata helper in the structured result.
