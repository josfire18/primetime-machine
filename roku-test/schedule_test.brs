' Unit tests for roku/source/schedule.brs, run with the BrightScript interpreter:
'   npx brs roku/source/schedule.brs roku-test/schedule_test.brs
sub Main()
    fails = 0
    segs = ParseJson("[{""role"":""program"",""start"":1795290720000,""end"":1795290750000,""fromSec"":0,""toSec"":30,""src"":""/media/a""}," + "{""role"":""ad"",""start"":1795290750000,""end"":1795290754000,""fromSec"":0,""toSec"":4,""src"":""/media/b""}," + "{""role"":""filler"",""start"":1795290754000,""end"":1795290780000,""fromSec"":0,""toSec"":26,""src"":null}]")
    t# = 1795290735500#
    s = SegmentAt(segs, t#)
    fails = fails + Check(s <> invalid and s.src = "/media/a", "segment at t")
    fails = fails + Check(Abs(OffsetSec(s, t#) - 15.5) < 0.001, "offset 15.5 s")
    fails = fails + Check(SegmentAt(segs, 1795290750000#).role = "ad", "boundary belongs to the next segment")
    fails = fails + Check(SegmentAt(segs, 1795290780000#) = invalid, "past the end")
    fails = fails + Check(SegmentAt(invalid, t#) = invalid, "no segments")
    fails = fails + Check(Plays(segs[1]) and not Plays(segs[2]), "ads play, filler doesn't")
    fails = fails + Check(MediaUrl("http://192.168.1.20:8420/", "/media/a") = "http://192.168.1.20:8420/media/a", "media url")
    fails = fails + Check(MediaUrl("http://h:1", "http://x/y") = "http://x/y", "absolute src kept")
    fails = fails + Check(StepChannel(0, 3, -1) = 2 and StepChannel(2, 3, 1) = 0 and StepChannel(1, 3, 1) = 2, "channel wrap")
    p = ParseJson("{""title"":""Pilot"",""show"":""Alpha"",""season"":1,""episode"":2,""year"":1991}")
    fails = fails + Check(ProgramLabel(p) = "Alpha", "label is the show")
    fails = fails + Check(Instr(1, ProgramDetail(p), "S1 E2") > 0 and Instr(1, ProgramDetail(p), "1991") > 0, "detail")
    fails = fails + Check(ProgramLabel(invalid) = "Station break", "no program")
    n# = NowMs()
    fails = fails + Check(n# > 1700000000000# and n# < 4102444800000#, "clock in ms")
    if fails = 0 then
        print "roku schedule OK"
    else
        print "roku schedule FAILED: "; fails
        stop
    end if
end sub

function Check(ok as Boolean, what as String) as Integer
    if ok then return 0
    print "FAIL: "; what
    return 1
end function
