-- The installer supplies fixed open-portal and signin-portal helpers in the app bundle.
on helperPath(helperName)
	return (POSIX path of (path to me)) & "Contents/Resources/" & helperName
end helperPath

on openHarnessy()
	try
		do shell script quoted form of my helperPath("open-portal")
	on error
		display alert "Harnessy could not open" message "The local portal may still be starting. Try again in a moment." as warning
	end try
end openHarnessy

on run
	my openHarnessy()
end run

on open location requestedURL
	if requestedURL is "harnessy://open" or requestedURL is "harnessy://open/" then
		my openHarnessy()
	else if requestedURL starts with "harnessy://signin/" then
		if (length of requestedURL) is not 61 then return
		set requestID to text 19 thru -1 of requestedURL
		try
			do shell script (quoted form of my helperPath("signin-portal")) & " " & quoted form of requestID
		on error
			display alert "Harnessy could not sign in" message "Return to the waiting tab and try again." as warning
		end try
	end if
end open location
