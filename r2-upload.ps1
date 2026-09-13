param([string]$AccessKey,[string]$SecretKey,[string]$Endpoint,[string]$Bucket,[string]$Key,[string]$FilePath)
$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Net.Http
$region='auto'; $service='s3'; $hostName=([Uri]$Endpoint).Host
$objectPath='/' + $Bucket + '/' + ((($Key -split '/') | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/')
function Hash([byte[]]$b) { $h=[Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($h.ComputeHash($b))).Replace('-','').ToLowerInvariant() } finally {$h.Dispose()} }
function Hmac([byte[]]$k,[string]$d) { $h=[Security.Cryptography.HMACSHA256]::new($k); try {$h.ComputeHash([Text.Encoding]::UTF8.GetBytes($d))} finally {$h.Dispose()} }
function SigningKey([string]$d) { $a=Hmac ([Text.Encoding]::UTF8.GetBytes("AWS4$SecretKey")) $d; $b=Hmac $a $region; $c=Hmac $b $service; Hmac $c 'aws4_request' }
function R2([string]$method,[string]$query,[byte[]]$body,[string]$type='') {
  $now=[DateTime]::UtcNow; $amz=$now.ToString('yyyyMMddTHHmmssZ'); $date=$now.ToString('yyyyMMdd'); $payload=Hash $body
  $headers="host:$hostName`nx-amz-content-sha256:$payload`nx-amz-date:$amz`n"; $signed='host;x-amz-content-sha256;x-amz-date'
  if($type){$headers="content-type:$type`n"+$headers;$signed='content-type;'+$signed}
  $canonical="$method`n$objectPath`n$query`n$headers`n$signed`n$payload"; $scope="$date/$region/$service/aws4_request"
  $str="AWS4-HMAC-SHA256`n$amz`n$scope`n$(Hash ([Text.Encoding]::UTF8.GetBytes($canonical)))"
  $signature=([BitConverter]::ToString((Hmac (SigningKey $date) $str))).Replace('-','').ToLowerInvariant()
  $uri="$Endpoint$objectPath"+$(if($query){"?$query"}else{''}); $req=[Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::$method,$uri)
  $req.Headers.TryAddWithoutValidation('x-amz-content-sha256',$payload)|Out-Null; $req.Headers.TryAddWithoutValidation('x-amz-date',$amz)|Out-Null
  $req.Headers.TryAddWithoutValidation('Authorization',"AWS4-HMAC-SHA256 Credential=$AccessKey/$scope, SignedHeaders=$signed, Signature=$signature")|Out-Null
  if($body.Length -gt 0 -or $method -in @('PUT','POST')){$req.Content=[Net.Http.ByteArrayContent]::new($body);if($type){$req.Content.Headers.ContentType=[Net.Http.Headers.MediaTypeHeaderValue]::Parse($type)}}
  $client=[Net.Http.HttpClient]::new();try{$res=$client.SendAsync($req).GetAwaiter().GetResult();$text=$res.Content.ReadAsStringAsync().GetAwaiter().GetResult();if(-not $res.IsSuccessStatusCode){throw "R2 $method failed ($([int]$res.StatusCode)): $text"};$text}finally{$client.Dispose();$req.Dispose()}
}
[xml]$init=R2 'POST' 'uploads=' ([byte[]]@()); $uploadId=$init.InitiateMultipartUploadResult.UploadId;if(-not $uploadId){throw 'R2 did not return an upload ID.'}
$stream=[IO.File]::OpenRead($FilePath);$log="$FilePath.upload.log";$partSize=100MB
try{$number=1;while($stream.Position -lt $stream.Length){$count=[int]([Math]::Min([int64]$partSize,[int64]($stream.Length-$stream.Position)));$buffer=[byte[]]::new($count);$read=0;while($read -lt $count){$read+=$stream.Read($buffer,$read,$count-$read)};$query="partNumber=$number&uploadId=$([Uri]::EscapeDataString($uploadId))";[void](R2 'PUT' $query $buffer 'application/zip');"Uploaded part $number ($count bytes)"|Add-Content -LiteralPath $log;$number++}
  $query="uploadId=$([Uri]::EscapeDataString($uploadId))";[xml]$parts=R2 'GET' $query ([byte[]]@());$doc=[Xml.XmlDocument]::new();$root=$doc.CreateElement('CompleteMultipartUpload');[void]$doc.AppendChild($root);foreach($part in $parts.ListPartsResult.Part){$p=$doc.CreateElement('Part');$n=$doc.CreateElement('PartNumber');$n.InnerText=$part.PartNumber;[void]$p.AppendChild($n);$e=$doc.CreateElement('ETag');$e.InnerText=$part.ETag;[void]$p.AppendChild($e);[void]$root.AppendChild($p)};[void](R2 'POST' $query ([Text.Encoding]::UTF8.GetBytes($doc.OuterXml)) 'application/xml');"UPLOAD_COMPLETE $($stream.Length) bytes"|Add-Content -LiteralPath $log
}finally{$stream.Dispose()}
