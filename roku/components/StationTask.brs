sub init()
    m.top.functionName = "fetch"
end sub

sub fetch()
    req = CreateObject("roUrlTransfer")
    req.SetUrl(m.top.url)
    req.SetCertificatesFile("common:/certs/ca-bundle.crt")
    req.RetainBodyOnError(true)
    port = CreateObject("roMessagePort")
    req.SetMessagePort(port)
    if not req.AsyncGetToString() then
        m.top.response = { ok: false, tag: m.top.tag, error: "couldn't start the request" }
        return
    end if
    msg = Wait(8000, port)
    if msg = invalid then
        req.AsyncCancel()
        m.top.response = { ok: false, tag: m.top.tag, error: "the station didn't answer" }
        return
    end if
    code = msg.GetResponseCode()
    if code <> 200 then
        m.top.response = { ok: false, tag: m.top.tag, error: "the station said " + code.ToStr() }
        return
    end if
    data = ParseJson(msg.GetString())
    if data = invalid then
        m.top.response = { ok: false, tag: m.top.tag, error: "the station sent something unreadable" }
        return
    end if
    m.top.response = { ok: true, tag: m.top.tag, data: data }
end sub
