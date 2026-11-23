^XA
^FX Dayson carton label - 60 x 40 mm at 203 dpi (480 x 320 dots). Spec section 6.
^FX QR with (01)(17)(10). ZPL cannot set the QR FNC1 mode indicator, so the
^FX data starts with a GS character (hex 1D); the scan parser accepts that.
^CI28
^CWT,E:TT0003M_.TTF
^PW480
^LL320
^LH0,0
^FO20,15^BQN,2,5^FH\^FDMA,\1D{{gs1}}^FS
^FO245,25^ATN,26,26^FB225,3,0,L^FH\^FD{{sku}}^FS
^FO245,120^ATN,22,22^FDLOT^FS
^FO245,145^ATN,36,36^FH\^FD{{lot}}^FS
^FO245,200^ATN,22,22^FDSON KULLANMA^FS
^FO245,225^ATN,36,36^FH\^FD{{expiry_tr}}^FS
^FO20,280^ATN,20,20^FB440,1,0,L^FH\^FD{{gs1_hri}}^FS
^PQ{{copies}},0,1,Y
^XZ
